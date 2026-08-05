import { describe, expect, it } from "vitest";
import { convertApifoxPathToOmni, isApifoxProject, parseApifoxProject } from "./parseApifoxProject";
import { parseProtocolImportText, ProtocolImportParseError } from "./parseProtocolImport";

const minimalApifox = {
  apifoxProject: "1.0.0",
  $schema: { app: "apifox", type: "project", version: "1.2.0" },
  info: { name: "Demo Project" },
  apiCollection: [
    {
      name: "根目录",
      items: [
        {
          name: "用户",
          items: [
            {
              name: "获取用户",
              api: {
                id: "1",
                method: "get",
                path: "/users/{userId}",
                type: "http",
                parameters: {
                  path: [{ name: "userId", enable: true, example: "1" }],
                  query: [
                    { name: "page", enable: true, schema: { default: 1 } },
                    { name: "q", enable: false },
                  ],
                  header: [{ name: "X-Token", enable: true, value: "abc" }],
                  cookie: [],
                },
                requestBody: { type: "none", parameters: [] },
                cases: [],
              },
            },
            {
              name: "创建用户",
              api: {
                id: "2",
                method: "post",
                path: "/users",
                type: "http",
                parameters: { path: [], query: [], header: [], cookie: [] },
                requestBody: { type: "application/json", parameters: [] },
                cases: [
                  {
                    requestBody: {
                      type: "application/json",
                      data: '{\n  "name": "Ada"\n}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("parseApifoxProject", () => {
  it("detects apifox project", () => {
    expect(isApifoxProject(minimalApifox)).toBe(true);
    expect(isApifoxProject({ openapi: "3.0.0" })).toBe(false);
  });

  it("converts path placeholders", () => {
    expect(convertApifoxPathToOmni("/users/{userId}/posts/{postId}")).toBe(
      "/users/:userId/posts/:postId",
    );
  });

  it("parses folders, methods, params and body example", () => {
    const doc = parseApifoxProject(minimalApifox);
    expect(doc.format).toBe("apifox");
    expect(doc.name).toBe("Demo Project");
    expect(doc.roots).toHaveLength(1);
    const project = doc.roots[0];
    expect(project.kind).toBe("folder");
    if (project.kind !== "folder") return;
    expect(project.folder.name).toBe("Demo Project");
    expect(project.folder.children).toHaveLength(1);
    const users = project.folder.children[0];
    expect(users.kind).toBe("folder");
    if (users.kind !== "folder") return;
    expect(users.folder.name).toBe("用户");
    expect(users.folder.children).toHaveLength(2);

    const getUser = users.folder.children[0];
    expect(getUser.kind).toBe("request");
    if (getUser.kind !== "request") return;
    expect(getUser.request.method).toBe("GET");
    expect(getUser.request.url).toBe("/users/:userId");
    expect(getUser.request.pathParams).toEqual([
      { key: "userId", value: "1", enabled: true },
    ]);
    expect(getUser.request.queryParams).toEqual([
      { key: "page", value: "1", enabled: true },
      { key: "q", value: "", enabled: false },
    ]);
    expect(getUser.request.headers.some((h) => h.key === "X-Token" && h.value === "abc")).toBe(
      true,
    );

    const createUser = users.folder.children[1];
    expect(createUser.kind).toBe("request");
    if (createUser.kind !== "request") return;
    expect(createUser.request.method).toBe("POST");
    expect(createUser.request.body).toContain('"name": "Ada"');
    expect(
      createUser.request.headers.some(
        (h) => h.key === "Content-Type" && h.value === "application/json",
      ),
    ).toBe(true);
  });
});

describe("parseProtocolImportText", () => {
  it("parses apifox json text", () => {
    const doc = parseProtocolImportText(JSON.stringify(minimalApifox));
    expect(doc.format).toBe("apifox");
  });

  it("rejects invalid json", () => {
    expect(() => parseProtocolImportText("{")).toThrow(ProtocolImportParseError);
  });

  it("rejects unsupported format", () => {
    expect(() => parseProtocolImportText(JSON.stringify({ openapi: "3.0.0" }))).toThrow(
      ProtocolImportParseError,
    );
  });
});
