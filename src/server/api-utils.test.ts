import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  badRequest,
  notFound,
  conflict,
  serverError,
  created,
  ok,
  accepted,
  noContent,
  parseBody,
  handleApi
} from "@/server/api-utils";

describe("api-utils", () => {
  describe("error responses", () => {
    it("badRequest returns 400 with error body", async () => {
      const res = badRequest("Invalid input", { field: "name" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid input");
      expect(body.details).toEqual({ field: "name" });
    });

    it("notFound returns 404", async () => {
      const res = notFound("Agent not found.");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    it("notFound has default message", async () => {
      const res = notFound();
      expect(res.status).toBe(404);
    });

    it("conflict returns 409", async () => {
      const res = conflict("Already exists.");
      expect(res.status).toBe(409);
    });

    it("serverError returns 500", async () => {
      const res = serverError("Boom");
      expect(res.status).toBe(500);
    });
  });

  describe("success responses", () => {
    it("created returns 201 with data", async () => {
      const res = created({ id: "123" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toEqual({ id: "123" });
    });

    it("ok returns 200 with data", async () => {
      const res = ok({ items: [] });
      expect(res.status).toBe(200);
    });

    it("accepted returns 202", async () => {
      const res = accepted({ runId: "run_1" });
      expect(res.status).toBe(202);
    });

    it("noContent returns 204 with null body", async () => {
      const res = noContent();
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
    });
  });

  describe("parseBody", () => {
    const schema = z.object({ name: z.string().min(1) });

    it("returns parsed data for valid body", async () => {
      const req = new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" })
      });
      const result = await parseBody(req, schema);
      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.name).toBe("test");
      }
    });

    it("returns 400 Response for invalid body", async () => {
      const req = new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" })
      });
      const result = await parseBody(req, schema);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    });

    it("returns 400 for non-json body", async () => {
      const req = new Request("http://localhost", {
        method: "POST",
        body: "not-json"
      });
      const result = await parseBody(req, schema);
      expect(result).toBeInstanceOf(Response);
    });
  });

  describe("handleApi", () => {
    it("returns 200 for successful handler", async () => {
      const res = await handleApi(async () => ({ result: "ok" }));
      expect(res.status).toBe(200);
    });

    it("returns 500 for throwing handler", async () => {
      const res = await handleApi(async () => {
        throw new Error("Something broke");
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Something broke");
    });

    it("passes through Response objects unchanged", async () => {
      const original = notFound("Gone");
      const res = await handleApi(async () => original);
      expect(res).toBe(original);
      expect(res.status).toBe(404);
    });
  });
});
