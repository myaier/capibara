import { bindTranslator, createTranslator } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";

// Fixture tests intentionally keep their original Chinese expectations. The real entry follows the device.
export let previewLanguage = new URLSearchParams(globalThis.location?.search ?? "").get("language") ?? "zh-CN";
export function setPreviewLanguage(language) {
  previewLanguage = language;
  bindTranslator(createTranslator(language, language === "zh-CN" ? [zh, kitZh] : [en, kitEn]));
}
setPreviewLanguage(previewLanguage);
