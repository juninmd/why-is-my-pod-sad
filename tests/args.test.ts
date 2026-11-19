import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/index.ts";

describe("parseArgs", () => {
  test("lê flags com valor e posicionais", () => {
    const a = parseArgs(["-n", "apps", "--tail", "20", "api", "--json"]);
    expect(a).toMatchObject({ namespace: "apps", tail: 20, query: "api", json: true, kind: "pod" });
  });

  test("`svc` como primeiro posicional troca o tipo", () => {
    expect(parseArgs(["svc", "api"])).toMatchObject({ kind: "service", query: "api" });
  });

  test("flag com valor não engole a flag seguinte", () => {
    expect(() => parseArgs(["-n", "--json"])).toThrow("exige um valor");
    expect(() => parseArgs(["--context"])).toThrow("exige um valor");
  });

  test("--tail rejeita zero, negativo e texto em vez de cair no padrão", () => {
    for (const bad of ["0", "-5", "abc", "1.5"]) {
      expect(() => parseArgs(["--tail", bad])).toThrow();
    }
  });

  test("opção desconhecida falha", () => {
    expect(() => parseArgs(["--nope"])).toThrow("opção desconhecida");
  });
});
