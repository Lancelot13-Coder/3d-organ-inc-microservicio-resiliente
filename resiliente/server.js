const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const { crearResiliencia } = require("./resiliencia");

// ---------- Configuración (todo opcional, ver README de despliegue) ----------
const limpiar = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
// Acepta la URL base o la URL con /api/modelos al final
const base = (v) => limpiar(v).replace(/\/api\/modelos\/?$/, "").replace(/\/+$/, "");

const CATALOGO = {
  python: { nombre: "Python", url: base(process.env.BACKEND_PYTHON_URL) || "https://threed-organ-inc-microservicio.onrender.com" },
  node: { nombre: "Node.js", url: base(process.env.BACKEND_NODE_URL) || "https://threed-organ-inc-microservicio-node.onrender.com" },
  java: { nombre: "Java", url: base(process.env.BACKEND_JAVA_URL) || "https://threed-organ-inc-microservicio-java.onrender.com" },
  go: { nombre: "Go", url: base(process.env.BACKEND_GO_URL) || "https://threed-organ-inc-microservicio-go.onrender.com" },
};
const ORDEN = (limpiar(process.env.BACKEND_ORDER) || "python,go,java,node")
  .split(",").map((c) => c.trim().toLowerCase()).filter((c) => CATALOGO[c]);

const resiliencia = crearResiliencia({
  backends: ORDEN.map((clave) => ({ clave, ...CATALOGO[clave] })),
  totalMs: Number(process.env.TOTAL_TIMEOUT_MS) || 45000,
  hedgeMs: Number(process.env.HEDGE_MS) || 5000,
  cooldownMs: Number(process.env.COOLDOWN_MS) || 30000,
});

const app = express();
app.use(cors({ exposedHeaders: ["X-Microservicio-Usado", "X-Intentos"] }));

// ---------- Documentación Swagger (OpenAPI 3) - solo lectura (GET) ----------
const errorResp = (d) => ({ description: d, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const cabeceras = {
  "X-Microservicio-Usado": { description: "Microservicio que finalmente respondió", schema: { type: "string", example: "go" } },
  "X-Intentos": { description: "Intentos realizados, p. ej. python:fallo;go:ok", schema: { type: "string", example: "python:fallo;go:ok" } },
};
const claves = ORDEN;
const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "Microservicio Resiliente - 3D Organ Inc",
    version: "1.0.0",
    description:
      "Gateway de SOLO LECTURA (GET). Consulta los microservicios de modelos 3D (Python, Node.js, Java y Go) y, " +
      "si uno falla o tarda demasiado, responde automáticamente con otro. No guarda datos ni necesita credenciales de Supabase.",
  },
  servers: [{ url: "/" }],
  tags: [{ name: "Lectura resiliente" }, { name: "Estado" }],
  paths: {
    "/": {
      get: { tags: ["Estado"], summary: "Información del servicio", responses: { 200: { description: "Servicio activo" } } },
    },
    "/api/modelos": {
      get: {
        tags: ["Lectura resiliente"],
        summary: "Listar modelos 3D con conmutación automática",
        parameters: [
          { name: "categoria", in: "query", schema: { type: "string" }, description: "Filtra por categoría exacta" },
          { name: "preferido", in: "query", schema: { type: "string", enum: claves }, description: "Microservicio que se intenta primero" },
        ],
        responses: {
          200: {
            description: "Lista de modelos (la devuelve el primer microservicio que responda)",
            headers: cabeceras,
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Modelo" } } } },
          },
          503: errorResp("Ningún microservicio pudo responder"),
        },
      },
    },
    "/api/modelos/{id}": {
      get: {
        tags: ["Lectura resiliente"],
        summary: "Obtener un modelo 3D con conmutación automática",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } },
          { name: "preferido", in: "query", schema: { type: "string", enum: claves }, description: "Microservicio que se intenta primero" },
        ],
        responses: {
          200: { description: "Modelo encontrado", headers: cabeceras, content: { "application/json": { schema: { $ref: "#/components/schemas/Modelo" } } } },
          400: errorResp("Id no numérico"),
          404: errorResp("Modelo no encontrado"),
          503: errorResp("Ningún microservicio pudo responder"),
        },
      },
    },
    "/api/estado": {
      get: {
        tags: ["Estado"],
        summary: "Estado de salud de cada microservicio",
        description: "Consulta a los cuatro en paralelo (también sirve para despertar los que están dormidos en Render).",
        responses: {
          200: {
            description: "Estado por servicio",
            content: { "application/json": { schema: { type: "object", properties: { servicios: { type: "array", items: { $ref: "#/components/schemas/EstadoServicio" } } } } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Modelo: {
        type: "object",
        properties: {
          id: { type: "integer", example: 1 },
          nombre: { type: "string" },
          descripcion: { type: "string" },
          categoria: { type: "string" },
          fecha_registro: { type: "string", format: "date-time" },
          activo: { type: "boolean" },
        },
      },
      EstadoServicio: {
        type: "object",
        properties: {
          servicio: { type: "string", example: "go" },
          nombre: { type: "string", example: "Go" },
          estado: { type: "string", enum: ["ok", "caido"] },
          ms: { type: "integer", example: 420 },
          registros: { type: "integer", nullable: true, example: 12 },
          detalle: { type: "string" },
        },
      },
      Error: {
        type: "object",
        properties: {
          detail: { type: "string" },
          intentos: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
};
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));

// ---------- Rutas (todas GET) ----------
app.get("/", (_req, res) =>
  res.json({ servicio: "microservicio-resiliente", estado: "ok", orden: ORDEN, docs: "/docs" })
);

async function responder(req, res, ruta) {
  try {
    const r = await resiliencia.consultar(ruta, limpiar(req.query.preferido).toLowerCase());
    res.set("X-Microservicio-Usado", r.servicio);
    res.set("X-Intentos", r.intentos.map((i) => `${i.servicio}:${i.resultado}`).join(";"));
    res.status(r.status).json(r.datos);
  } catch (e) {
    res.status(503).json({ detail: "Ningún microservicio pudo responder", intentos: (e && e.intentos) || [] });
  }
}

app.get("/api/modelos", (req, res) => {
  const cat = req.query.categoria;
  responder(req, res, "/api/modelos" + (cat ? `?categoria=${encodeURIComponent(cat)}` : ""));
});

app.get("/api/modelos/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ detail: "El id debe ser numérico" });
  responder(req, res, `/api/modelos/${id}`);
});

app.get("/api/estado", async (_req, res) => res.json({ servicios: await resiliencia.estado() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Resiliente escuchando en puerto ${PORT}`);
  console.log("Orden de servicios:", ORDEN.map((c) => `${c}=${CATALOGO[c].url}`).join(" | "));
});
