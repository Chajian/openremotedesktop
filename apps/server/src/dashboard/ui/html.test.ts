import { describe, expect, it } from "vitest";
import { html, raw } from "./html.js";

describe("html", () => {
  it("escapes interpolated strings and numbers", () => {
    expect(html`<p title="${'"x"'}">${"<b>&</b>"} ${42}</p>`.value)
      .toBe('<p title="&quot;x&quot;">&lt;b&gt;&amp;&lt;/b&gt; 42</p>');
  });
  it("inserts SafeHtml unescaped and flattens arrays", () => {
    expect(html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`.value).toBe("<ul><li>a</li><li>&lt;b&gt;</li></ul>");
    expect(html`${raw("<br>")}`.value).toBe("<br>");
  });
  it("renders null, undefined and booleans as empty", () => {
    expect(html`[${null}${undefined}${false}${true}]`.value).toBe("[]");
  });
});
