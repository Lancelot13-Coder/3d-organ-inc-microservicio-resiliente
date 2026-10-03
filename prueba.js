// Pruebas locales de la lógica de resiliencia (sin Render ni Supabase):  npm test
const http = require("http");
const assert = require("assert");
const { crearResiliencia } = require("./resiliencia");

function servidor(puerto, manejador) {
  return new Promise((ok) => { const s = http.createServer(manejador); s.listen(puerto, () => ok(s)); });
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

(async () => {
  const bueno = (nombre) => (req, res) => json(res, req.url.includes("/999") ? 404 : 200, req.url.includes("/999") ? { detail: "no existe" } : [{ id: 1, nombre }]);
  const caido = (req, res) => json(res, 500, { detail: "boom" });
  const lento = (req, res) => setTimeout(() => json(res, 200, [{ id: 1, nombre: "lento" }]), 1500);

  const s = [
    await servidor(19001, caido),
    await servidor(19002, lento),
    await servidor(19003, bueno("C")),
    await servidor(19004, bueno("D")),
  ];
  const B = (clave, puerto) => ({ clave, nombre: clave, url: `http://localhost:${puerto}` });
  const nuevo = () => crearResiliencia({
    backends: [B("a", 19001), B("b", 19002), B("c", 19003), B("d", 19004)],
    totalMs: 5000, hedgeMs: 200, cooldownMs: 60000,
  });

  // 1) A falla (500) -> B es lento -> a los 200 ms entra C y gana
  let r = nuevo();
  let x = await r.consultar("/api/modelos");
  assert.strictEqual(x.servicio, "c");
  assert.strictEqual(x.intentos[0].servicio, "a");
  assert.strictEqual(x.intentos[0].resultado, "fallo");
  console.log("OK 1: failover por error 500 + hedging por lentitud ->", x.servicio);

  // 2) circuito: A queda en enfriamiento y pasa al final
  assert.strictEqual(r.ordenados()[3].clave, "a");
  console.log("OK 2: servicio caído pasa al final de la fila");

  // 3) preferido
  r = nuevo();
  x = await r.consultar("/api/modelos", "d");
  assert.strictEqual(x.servicio, "d");
  console.log("OK 3: ?preferido=d responde d directamente");

  // 4) 404 legítimo no hace failover
  r = nuevo();
  x = await r.consultar("/api/modelos/999", "c");
  assert.strictEqual(x.status, 404);
  assert.strictEqual(x.servicio, "c");
  console.log("OK 4: 404 se devuelve tal cual, sin cambiar de servicio");

  // 5) todos caídos -> rechaza con los intentos
  const todos = crearResiliencia({ backends: [B("a", 19001), B("z", 19099)], totalMs: 3000, hedgeMs: 200 });
  try { await todos.consultar("/api/modelos"); assert.fail("debía rechazar"); }
  catch (e) { assert.strictEqual(e.intentos.length, 2); console.log("OK 5: todos caídos -> rechaza con", e.intentos.length, "intentos"); }

  // 6) estado
  r = crearResiliencia({ backends: [B("a", 19001), B("c", 19003), B("z", 19099)] });
  const est = await r.estado(3000);
  assert.deepStrictEqual(est.map((e) => e.estado), ["caido", "ok", "caido"]);
  console.log("OK 6: /api/estado ->", est.map((e) => e.servicio + ":" + e.estado).join(", "));

  s.forEach((x) => x.close());
  console.log("\nTodas las pruebas pasaron");
  process.exit(0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
