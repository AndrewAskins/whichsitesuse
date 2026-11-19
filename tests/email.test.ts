import { describe, expect, it } from "vitest";
import { domainCandidates, parseEmail } from "../src/auth/email.js";
import { parseDisposable, parseFreemail } from "../src/auth/emailLists.js";

describe("parseEmail", () => {
  it("normalizes one inbox to one person", () => {
    expect(parseEmail(" A.Lice+promo@GMail.com ")).toEqual({ email: "a.lice+promo@gmail.com", normalized: "alice@gmail.com", domain: "gmail.com" });
    expect(parseEmail("alice@googlemail.com")?.normalized).toBe("alice@gmail.com");
    expect(parseEmail("first.last+x@acme.com")?.normalized).toBe("first.last@acme.com");
  });

  it("rejects things that aren't addresses", () => {
    expect(parseEmail("nope")).toBeNull();
    expect(parseEmail("+tag@acme.com")).toBeNull();
    expect(parseEmail("a@b")).toBeNull();
  });
});

describe("domainCandidates", () => {
  it("lists every suffix with two labels or more", () => {
    expect(domainCandidates("mail.acme.co.uk")).toEqual(["mail.acme.co.uk", "acme.co.uk", "co.uk"]);
    expect(domainCandidates("acme.com")).toEqual(["acme.com"]);
  });
});

describe("list parsers", () => {
  it("reads the disposable list's one-per-line format", () => {
    expect(parseDisposable("# comment\nMailinator.com\n\nyopmail.com\n")).toEqual(["mailinator.com", "yopmail.com"]);
  });
  it("reads the free-mail JSON array", () => {
    expect(parseFreemail('["gmail.com","Yahoo.com",3]')).toEqual(["gmail.com", "yahoo.com"]);
  });
});
