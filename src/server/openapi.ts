export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Personal Knowledge Base RAG API",
    version: "1.0.0",
    description: "Authenticated APIs for knowledge bases, documents, RAG search, chat, admin, audit, and DeepSeek configuration."
  },
  servers: [{ url: "/api" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT"
      }
    },
    schemas: {
      ApiResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          code: { type: "integer", example: 0 },
          message: { type: "string", example: "ok" },
          data: {}
        }
      },
      Page: {
        type: "object",
        properties: {
          items: { type: "array", items: {} },
          page: { type: "integer" },
          pageSize: { type: "integer" },
          total: { type: "integer" }
        }
      },
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string" },
          password: { type: "string" }
        }
      },
      KnowledgeBaseInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          visibility: { type: "string", enum: ["PUBLIC", "DEPARTMENT", "MEMBERS", "PRIVATE"] },
          departmentId: { type: "integer" },
          tags: { type: "array", items: { type: "string" } }
        }
      },
      SearchRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["keyword", "vector", "hybrid"], default: "hybrid" },
          topK: { type: "integer" },
          minScore: { type: "number" },
          filters: {
            type: "object",
            properties: {
              documentIds: { type: "array", items: { type: "integer" } },
              tags: { type: "array", items: { type: "string" } }
            }
          }
        }
      },
      QuestionRequest: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          mode: { type: "string", enum: ["strict", "general"], default: "strict" }
        }
      },
      ChatSessionUpdate: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 255 }
        }
      },
      LlmConfigInput: {
        type: "object",
        required: ["provider", "baseUrl", "chatModel", "embeddingModel"],
        properties: {
          provider: { type: "string", example: "deepseek" },
          baseUrl: { type: "string", example: "https://api.deepseek.com" },
          apiKey: { type: "string" },
          clearApiKey: { type: "boolean" },
          chatModel: { type: "string", example: "deepseek-v4-flash" },
          reasoningModel: { type: "string", example: "deepseek-v4-pro" },
          thinking: { type: "string", enum: ["enabled", "disabled"] },
          reasoningEffort: { type: "string", enum: ["high", "max"] },
          maxTokens: { type: "integer" },
          embeddingModel: { type: "string", example: "local-hashing" }
        }
      }
    },
    parameters: {
      Page: { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
      PageSize: { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }
    }
  },
  paths: {
    "/health": { get: publicGet("Health check") },
    "/auth/register": { post: publicPost("Register user", "LoginRequest") },
    "/auth/login": { post: publicPost("Login", "LoginRequest") },
    "/auth/refresh": { post: publicPost("Refresh access token") },
    "/auth/logout": { post: authedPost("Logout") },
    "/users/me": { get: authedGet("Current user") },
    "/users/me/password": { patch: authedPost("Change current user password") },
    "/departments": { get: authedGet("List departments") },
    "/users": { get: authedPagedGet("List users") },
    "/knowledge-bases": {
      get: authedPagedGet("List knowledge bases", [
        { name: "keyword", in: "query", schema: { type: "string" } },
        { name: "role", in: "query", schema: { type: "string", enum: ["owner", "manager", "reader"] } }
      ]),
      post: authedPost("Create knowledge base", "KnowledgeBaseInput")
    },
    "/knowledge-bases/{kbId}": {
      get: authedPathGet("Get knowledge base", "kbId"),
      put: authedPathPost("Update knowledge base", "kbId", "KnowledgeBaseInput"),
      patch: authedPathPost("Patch knowledge base", "kbId", "KnowledgeBaseInput"),
      delete: authedPathDelete("Delete knowledge base", "kbId")
    },
    "/knowledge-bases/{kbId}/members": {
      get: authedPathGet("List knowledge base members", "kbId"),
      post: authedPathPost("Add or update member", "kbId")
    },
    "/knowledge-bases/{kbId}/documents": {
      get: authedPagedPathGet("List documents", "kbId", [
        { name: "status", in: "query", schema: { type: "string" } },
        { name: "keyword", in: "query", schema: { type: "string" } }
      ]),
      post: authedPathPost("Upload document", "kbId")
    },
    "/knowledge-bases/{kbId}/tags": {
      get: authedPathGet("List tags", "kbId"),
      post: authedPathPost("Create tag", "kbId")
    },
    "/knowledge-bases/{kbId}/search": {
      post: authedPathPost("Search knowledge base", "kbId", "SearchRequest")
    },
    "/knowledge-bases/{kbId}/chat/sessions": {
      post: authedPathPost("Create chat session for knowledge base", "kbId")
    },
    "/documents/{documentId}": {
      get: authedPathGet("Get document", "documentId"),
      delete: authedPathDelete("Delete document", "documentId")
    },
    "/documents/{documentId}/download": { get: authedPathGet("Download document", "documentId") },
    "/documents/{documentId}/reparse": { post: authedPathPost("Reparse document", "documentId") },
    "/documents/{documentId}/chunks": { get: authedPagedPathGet("List chunks", "documentId") },
    "/documents/{documentId}/tags": { post: authedPathPost("Update document tags", "documentId") },
    "/tasks/{taskId}": { get: authedPathGet("Get task status", "taskId") },
    "/chat/sessions": {
      get: authedGet("List chat sessions", [
        { name: "kbId", in: "query", schema: { type: "integer" } },
        { name: "status", in: "query", schema: { type: "string", enum: ["active", "archived", "all"], default: "active" } }
      ]),
      post: authedPost("Create chat session")
    },
    "/chat/sessions/{sessionId}": {
      patch: authedPathPost("Rename chat session", "sessionId", "ChatSessionUpdate"),
      delete: authedPathDelete("Delete chat session", "sessionId")
    },
    "/chat/sessions/{sessionId}/archive": { post: authedPathPost("Archive chat session", "sessionId") },
    "/chat/sessions/{sessionId}/restore": { post: authedPathPost("Restore chat session", "sessionId") },
    "/chat/sessions/{sessionId}/messages": {
      get: authedPathGet("List messages", "sessionId"),
      post: authedPathPost("Ask question", "sessionId", "QuestionRequest")
    },
    "/chat/sessions/{sessionId}/stream": { post: authedPathPost("Ask question as SSE stream", "sessionId", "QuestionRequest") },
    "/chat/messages/{messageId}/feedback": { post: authedPathPost("Submit answer feedback", "messageId") },
    "/prompts": { get: authedGet("List prompts"), post: authedPost("Create prompt") },
    "/workflows": { get: authedGet("List workflows"), post: authedPost("Create workflow") },
    "/workflows/{workflowId}/run": { post: authedPathPost("Run workflow", "workflowId") },
    "/dashboard/overview": { get: authedGet("Dashboard overview") },
    "/system/stats": { get: authedGet("System stats") },
    "/admin/users": { get: authedPagedGet("Admin list users") },
    "/admin/users/{userId}/status": { patch: authedPathPost("Admin update user status", "userId") },
    "/admin/audit-logs": { get: authedPagedGet("Admin audit logs") },
    "/admin/stats": { get: authedGet("Admin stats") },
    "/admin/llm-config": { get: authedGet("Get DeepSeek config"), put: authedPost("Update DeepSeek config", "LlmConfigInput") },
    "/admin/llm-config/test": { post: authedPost("Test DeepSeek config") }
  }
} as const;

function okResponse() {
  return {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ApiResponse" }
        }
      }
    }
  };
}

function body(schemaName?: string) {
  return schemaName
    ? {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schemaName}` }
          }
        }
      }
    : undefined;
}

function publicGet(summary: string) {
  return { summary, security: [], responses: okResponse() };
}

function publicPost(summary: string, schemaName?: string) {
  return { summary, security: [], requestBody: body(schemaName), responses: okResponse() };
}

function authedGet(summary: string, parameters: unknown[] = []) {
  return { summary, parameters, responses: okResponse() };
}

function authedPagedGet(summary: string, parameters: unknown[] = []) {
  return {
    summary,
    parameters: [{ $ref: "#/components/parameters/Page" }, { $ref: "#/components/parameters/PageSize" }, ...parameters],
    responses: okResponse()
  };
}

function authedPost(summary: string, schemaName?: string) {
  return { summary, requestBody: body(schemaName), responses: okResponse() };
}

function pathParam(name: string) {
  return { name, in: "path", required: true, schema: { type: "integer" } };
}

function authedPathGet(summary: string, name: string, parameters: unknown[] = []) {
  return authedGet(summary, [pathParam(name), ...parameters]);
}

function authedPagedPathGet(summary: string, name: string, parameters: unknown[] = []) {
  return authedPagedGet(summary, [pathParam(name), ...parameters]);
}

function authedPathPost(summary: string, name: string, schemaName?: string) {
  return { summary, parameters: [pathParam(name)], requestBody: body(schemaName), responses: okResponse() };
}

function authedPathDelete(summary: string, name: string) {
  return { summary, parameters: [pathParam(name)], responses: okResponse() };
}
