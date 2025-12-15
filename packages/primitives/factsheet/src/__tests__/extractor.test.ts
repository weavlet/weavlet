
import { describe, it, expect, vi } from "vitest";
import { Extractor } from "../extractor";
import { z } from "zod";
import type { ExtractorConfig } from "../types";

describe("Extractor Fallback Logic", () => {
    const schema = z.object({ value: z.string() });

    it("should throw when extractFrom is 'output' but output is undefined", async () => {
        const custom = vi.fn();
        const config: ExtractorConfig = {
            baseURL: "mock",
            apiKey: "mock",
            model: "mock",
            extractFrom: "output", // Default config
            custom: custom,
        };

        const extractor = new Extractor(config);

        // Test case 1: config level
        await expect(extractor.extract("some input", undefined, schema))
            .rejects
            .toThrow("Extraction source is 'output' but no output provided");

        // Test case 2: override level
        await expect(extractor.extract("some input", undefined, schema, "output"))
            .rejects
            .toThrow("Extraction source is 'output' but no output provided");

        // Should NOT call the custom extractor
        expect(custom).not.toHaveBeenCalled();
    });

    it("should succeed when extractFrom is 'output' and output is provided", async () => {
        const custom = vi.fn().mockResolvedValue({ candidates: [] });
        const config: ExtractorConfig = {
            baseURL: "mock",
            apiKey: "mock",
            model: "mock",
            custom: custom,
        };

        const extractor = new Extractor(config);
        // Explicit override
        await extractor.extract("some input", "some output", schema, "output");

        expect(custom).toHaveBeenCalledWith(
            "some output", // Sanitized text (assuming no control chars)
            "some output", // Output arg
            schema,
            {
                extractFrom: "output",
                maxInputChars: 8000,
                timeoutMs: 5000,
                retries: 2,
                onError: "skip",
                rawInput: "some input",
                rawOutput: "some output",
            }
        );
    });
});

describe("Extractor Prompt Structure", () => {
    const mockFetch = vi.fn();

    it("should recursively describe nested objects in the system prompt", async () => {
        vi.stubGlobal('fetch', mockFetch);
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "{}" } }] }),
        });

        const schema = z.object({
            user: z.object({
                name: z.string().describe("User's full name"),
                address: z.object({
                    city: z.string(),
                    zip: z.string()
                })
            }),
            tags: z.array(z.string())
        });

        const extractor = new Extractor({
            model: "gpt-4",
            apiKey: "test-key",
            baseURL: "https://api.openai.com/v1"
        });

        await extractor.extract("some input", undefined, schema);

        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        const systemPrompt = body.messages.find((m: any) => m.role === "system").content;

        expect(systemPrompt).toContain('Schema:');
        expect(systemPrompt).toContain('"user": {');
        expect(systemPrompt).toContain('"name": "string (User\'s full name)"');
        expect(systemPrompt).toContain('"city": "string"');
        expect(systemPrompt).toContain('"tags": [');
        expect(systemPrompt).toContain('"string"');

        vi.unstubAllGlobals();
    });
});

describe("Extractor Zod Type Support", () => {
    const mockFetch = vi.fn();

    it("should correctly describe complex Zod types", async () => {
        vi.stubGlobal('fetch', mockFetch);
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "{}" } }] }),
        });

        const schema = z.object({
            dateField: z.date(),
            tupleField: z.tuple([z.string(), z.number()]),
            setField: z.set(z.number()),
            mapField: z.map(z.string(), z.number()),
            bigIntField: z.bigint(),
        });

        const extractor = new Extractor({
            model: "gpt-4",
            apiKey: "test-key",
            baseURL: "https://api.openai.com/v1"
        });

        await extractor.extract("some input", undefined, schema);

        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        const systemPrompt = body.messages.find((m: any) => m.role === "system").content;

        expect(systemPrompt).toContain('"dateField": "date (ISO 8601)"');
        expect(systemPrompt).toContain('"tupleField": [\n    "string",\n    "number"\n  ]');
        expect(systemPrompt).toContain('"setField": "set<number>"');
        expect(systemPrompt).toContain('"mapField": "map<string, number>"');
        expect(systemPrompt).toContain('"bigIntField": "bigint"');

        vi.unstubAllGlobals();
    });
});
