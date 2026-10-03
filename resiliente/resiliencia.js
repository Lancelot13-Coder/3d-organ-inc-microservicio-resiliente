// Lógica de resiliencia (sin dependencias externas).
//
// Estrategia "hedged request + circuit breaker":
//  1. Se consulta primero el microservicio preferido (o el primero del orden).
//  2. Si falla (error de red, HTTP 5xx, respuesta que no es JSON), se pasa de
//     inmediato al siguiente.
//  3. Si tarda más de `hedgeMs` sin responder (típico de un servicio dormido en
//     Render), se lanza el siguiente EN PARALELO sin cancelar el anterior.
//     Gana el primero que responda bien; los demás se cancelan.
//  4. Un servicio que falla queda "en enfriamiento" `cooldownMs`: durante ese
//     tiempo se consulta al final de la fila.
//  5. Un 4xx (por ejemplo 404 "no existe") es una respuesta válida: se devuelve
//     tal cual, no se cambia de servicio.

function crearResiliencia({ backends, totalMs = 45000, hedgeMs = 5000, cooldownMs = 30000 }) {
  const circuito = new Map(); // clave -> { hasta: timestamp }

  const enEnfriamiento = (b) => (circuito.get(b.clave)?.hasta || 0) > Date.now();
  const marcarFallo = (b) => circuito.set(b.clave, { hasta: Date.now() + cooldownMs });
  const marcarOk = (b) => circuito.delete(b.clave);

  function ordenados(preferido) {
    let lista = [...backends];
    const i = lista.findIndex((b) => b.clave === preferido);
    if (i > 0) lista.unshift(...lista.splice(i, 1));
    return [...lista.filter((b) => !enEnfriamiento(b)), ...lista.filter(enEnfriamiento)];
  }

  async function pedir(b, ruta, signal) {
    const res = await fetch(b.url + ruta, { signal, headers: { Accept: "application/json" } });
    if (res.status >= 500) throw new Error("HTTP " + res.status);
    const texto = await res.text();
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      throw new Error("La respuesta no es JSON válido");
    }
    return { status: res.status, datos };
  }

  // Resuelve { status, datos, servicio, intentos } o rechaza { intentos }.
  function consultar(ruta, preferido) {
    const orden = ordenados(preferido);
    return new Promise((resolve, reject) => {
      const intentos = [];
      const controladores = [];
      let terminado = false;
      let siguiente = 0;
      let enVuelo = 0;
      let temporizador = null;

      const terminar = (accion, valor) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(temporizador);
        clearTimeout(limite);
        controladores.forEach((c) => c.abort());
        accion(valor);
      };
      const limite = setTimeout(() => terminar(reject, { intentos }), totalMs);

      const lanzarSiguiente = () => {
        if (terminado || siguiente >= orden.length) return;
        const b = orden[siguiente++];
        const ctrl = new AbortController();
        controladores.push(ctrl);
        enVuelo++;
        const inicio = Date.now();

        clearTimeout(temporizador);
        if (siguiente < orden.length) temporizador = setTimeout(lanzarSiguiente, hedgeMs);

        pedir(b, ruta, ctrl.signal)
          .then((r) => {
            enVuelo--;
            if (terminado) return;
            marcarOk(b);
            intentos.push({ servicio: b.clave, resultado: "ok", ms: Date.now() - inicio });
            terminar(resolve, { ...r, servicio: b.clave, intentos });
          })
          .catch((err) => {
            enVuelo--;
            if (terminado) return;
            marcarFallo(b);
            intentos.push({ servicio: b.clave, resultado: "fallo", ms: Date.now() - inicio, error: err.message });
            if (siguiente < orden.length) {
              lanzarSiguiente();
            } else if (enVuelo === 0) {
              terminar(reject, { intentos });
            }
          });
      };

      lanzarSiguiente();
    });
  }

  // Revisa todos los servicios en paralelo (también sirve para despertarlos).
  async function estado(timeoutMs = 20000) {
    return Promise.all(
      backends.map(async (b) => {
        const inicio = Date.now();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await pedir(b, "/api/modelos", ctrl.signal);
          marcarOk(b);
          return { servicio: b.clave, nombre: b.nombre, estado: "ok", ms: Date.now() - inicio, registros: Array.isArray(r.datos) ? r.datos.length : null };
        } catch (e) {
          marcarFallo(b);
          return { servicio: b.clave, nombre: b.nombre, estado: "caido", ms: Date.now() - inicio, detalle: e.name === "AbortError" ? "Sin respuesta (timeout)" : e.message };
        } finally {
          clearTimeout(t);
        }
      })
    );
  }

  return { consultar, estado, ordenados, backends };
}

module.exports = { crearResiliencia };
