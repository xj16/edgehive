/**
 * Hand-authored OpenAPI 3.0 description of the EdgeHive API, served at
 * `/openapi.json`. Kept dependency-free (no code-gen, no `@hono/zod-openapi`)
 * so it runs identically on Bun, Deno and Node and adds zero install weight.
 *
 * This is the machine-readable replacement for the old hand-maintained Postman
 * collection: it powers the interactive `/docs` explorer and can be imported
 * into Postman/Insomnia/Bruno or fed to a client generator.
 */

export function openApiSpec(version: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "EdgeHive API",
      version,
      description:
        "Edge-native realtime API for Bun, Deno & Firebase. Public read feed, " +
        "authenticated writes, and live change streams over Server-Sent Events.",
      license: { name: "MIT", url: "https://github.com/xj16/edgehive/blob/main/LICENSE" },
    },
    servers: [{ url: "/", description: "This server" }],
    tags: [
      { name: "system", description: "Health, metrics and service metadata" },
      { name: "auth", description: "Dev bearer-token issue/verify" },
      { name: "documents", description: "CRUD + query over collections" },
      { name: "realtime", description: "Server-Sent Events change stream" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Document: {
          type: "object",
          properties: {
            id: { type: "string", example: "aB3xY7z1qLmN0p9QwErt" },
            data: { type: "object", additionalProperties: true },
            createTime: { type: "string", format: "date-time" },
            updateTime: { type: "string", format: "date-time" },
          },
          required: ["id", "data"],
        },
        DocumentList: {
          type: "object",
          properties: {
            collection: { type: "string" },
            count: { type: "integer" },
            documents: { type: "array", items: { $ref: "#/components/schemas/Document" } },
            nextPageToken: { type: "string", nullable: true },
          },
        },
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["system"],
          summary: "Health + store/runtime/latency diagnostics",
          responses: { "200": { description: "Service is up" } },
        },
      },
      "/metrics": {
        get: {
          tags: ["system"],
          summary: "Prometheus metrics (text exposition format)",
          responses: { "200": { description: "Metrics" } },
        },
      },
      "/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Mint a dev bearer token for an email",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { email: { type: "string", format: "email" } },
                  required: ["email"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Token minted" },
            "400": {
              description: "Invalid email",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/auth/me": {
        get: {
          tags: ["auth"],
          summary: "Echo the authenticated user",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "The user" }, "401": { description: "Unauthorized" } },
        },
      },
      "/v1/{col}": {
        parameters: [
          { name: "col", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["documents"],
          summary: "List / query documents in a collection",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
            },
            { name: "pageToken", in: "query", schema: { type: "string" } },
            {
              name: "orderBy",
              in: "query",
              description: "Field to sort by; prefix with '-' for descending.",
              schema: { type: "string" },
            },
            {
              name: "direction",
              in: "query",
              schema: { type: "string", enum: ["asc", "desc"] },
            },
            {
              name: "where",
              in: "query",
              description: "Repeatable filter like `done==false` or `priority>=2`.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "A page of documents",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/DocumentList" } },
              },
            },
            "400": { description: "Invalid query" },
          },
        },
        post: {
          tags: ["documents"],
          summary: "Create a document (emits `created`)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Document" } } },
            },
            "401": { description: "Unauthorized" },
            "413": { description: "Body too large" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/v1/{col}/{id}": {
        parameters: [
          { name: "col", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["documents"],
          summary: "Fetch one document",
          responses: {
            "200": {
              description: "The document",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Document" } } },
            },
            "404": { description: "Not found" },
          },
        },
        put: {
          tags: ["documents"],
          summary: "Upsert a document (emits `updated`)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          responses: { "200": { description: "Upserted" }, "401": { description: "Unauthorized" } },
        },
        delete: {
          tags: ["documents"],
          summary: "Delete a document (emits `deleted`)",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Deleted" }, "401": { description: "Unauthorized" } },
        },
      },
      "/v1/{col}/stream": {
        get: {
          tags: ["realtime"],
          summary: "Realtime SSE change stream (sends an initial snapshot on connect)",
          parameters: [
            { name: "col", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description:
                "An `text/event-stream` emitting `ready`, `snapshot`, then " +
                "`created`/`updated`/`deleted` events plus periodic `heartbeat`s.",
              content: { "text/event-stream": {} },
            },
            "429": { description: "Too many concurrent streams from this client" },
          },
        },
      },
    },
  };
}
