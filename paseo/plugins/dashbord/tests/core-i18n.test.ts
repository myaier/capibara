import assert from "node:assert/strict";
import test from "node:test";
import { bindTranslator, createTranslator, translator } from "../shared/i18n";
import en from "../shared/locales/en.json";
import zh from "../shared/locales/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import { deferredSourceLabel, ledgerNotice, messageKey, SOURCES } from "../client/deferred-state";

test("deferred source identity stays stable while historical source titles follow the selected language", () => {
  const previous = translator();
  try {
    bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
    const source = `${SOURCES.finding}「Review changes」`, key = messageKey(SOURCES.finding, "Review changes");
    assert.equal(deferredSourceLabel(source), "分析建议「Review changes」");
    bindTranslator(createTranslator("en", [en, kitEn]));
    assert.equal(deferredSourceLabel(source), 'Analysis suggestion "Review changes"');
    assert.equal(deferredSourceLabel(`${SOURCES.quickReply}「Continue」`), 'Quick reply "Continue"');
    assert.equal(deferredSourceLabel(`${SOURCES.finding}「A truncated title`), 'Analysis suggestion "A truncated title"');
    assert.equal(messageKey(SOURCES.finding, "Review changes"), key);
    assert.equal(deferredSourceLabel("User-defined source"), "User-defined source");
  } finally { bindTranslator(previous); }
});

test("deferred notices use English sentences and preserve the existing Chinese text", () => {
  const previous = translator();
  try {
    bindTranslator(createTranslator("en", [en, kitEn]));
    assert.equal(ledgerNotice({ state: "queued", note: "" }, "Build", "Continue").text, 'Queued: Continue. It will send automatically when "Build" finishes this turn');
    assert.equal(ledgerNotice({ state: "held", note: "" }, "Build", "Continue").text, '"Continue" is waiting for your confirmation. See below.');
    bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
    assert.equal(ledgerNotice({ state: "queued", note: "" }, "Build", "Continue").text, '已排队：Continue，等「Build」这一轮结束后自动发送');
    assert.equal(ledgerNotice({ state: "held", note: "" }, "Build", "Continue").text, '「Continue」在等你确认，见下方。');
  } finally { bindTranslator(previous); }
});
