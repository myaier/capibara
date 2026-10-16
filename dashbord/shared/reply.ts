import { onTextChange } from "./i18n";
import { t } from "./text";
/**
 * 待回复: does an Agent's final reply hand the next step to the user? Used by the server when a turn ends and by its
 * backfill for turns the hooks missed. Only the resulting boolean is stored, never the reply text.
 */
import { string, type TimelineItem, type TimelineRow } from "./timeline";

/** Items a turn can close with after its final message without changing what that message says. */
const TRAILING = new Set(["reasoning", "todo", "notification", "compaction", "plugin"]);

/** The turn's closing assistant message (consecutive chunks joined), or null when it ended on a tool call, an error or nothing. */
export function finalReplyText(items: readonly TimelineItem[]): string | null {
  let index = items.length - 1;
  while (index >= 0 && TRAILING.has(items[index].type)) index--;
  const parts: string[] = [];
  for (; index >= 0 && items[index].type === "assistant_message"; index--) parts.unshift(string(items[index].text));
  return parts.join("").trim() || null;
}

/** The final reply in a projected timeline tail, if it answers the user message sent at `userAt` (epoch ms). */
export function finalReplyAfter(rows: readonly TimelineRow[], userAt: number): { at: string; text: string } | null {
  let index = rows.length - 1;
  while (index >= 0 && TRAILING.has(rows[index].item.type)) index--;
  const last = rows[index];
  if (!last || last.item.type !== "assistant_message") return null;
  const parts: string[] = [];
  for (; index >= 0 && rows[index].item.type === "assistant_message"; index--) parts.unshift(string(rows[index].item.text));
  const at = Date.parse(last.timestamp), text = parts.join("").trim();
  return text && Number.isFinite(at) && at >= userAt ? { at: new Date(at).toISOString(), text } : null;
}

// An explicit request for something only the user can give: a decision, a confirmation, output, credentials, a go-ahead.
const REQUEST = /(请你?|麻烦你?|烦请|劳烦)(再|先|帮忙)?(确认|选择|选一下|决定|回复|提供|告诉我|发给我|贴给我|批准|审批|授权|登录|看一下|看看)|(告诉|通知|发给|贴给|回复|转给)我|等你(的|来|先)?(确认|决定|回复|拍板|提供|消息|反馈|同意|指示|批准|选择)|由你(来)?(决定|定|选择|拍板)|你(来|自己)?(决定|定夺|拍板)|需要你(先|来|去|帮忙)?(确认|决定|提供|选择|处理|批准|审批|登录|操作|授权|回复|补充|拍板)|\b(send me|let me know|tell me|please (confirm|choose|decide|provide|reply|share|approve|review))\b|\byour call\b|\bup to you\b/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
// A question addressed to the user or offering the next step (rhetorical questions answered in place do not count).
const ASK = /要不要|需不需要|用不用|是否|要我|需要我|我(来|可以|先|再|就|直接|帮你)|可以吗|行吗|好吗|对吗|同意吗|怎么(处理|办|选|定)|如何(处理|选择)|哪(个|种|一|些|边)|还是|你|您|\b(should|shall|would|do|does|can|could|will|want|which|whether)\b/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.

/**
 * A courtesy close that offers help in general — 「如果还有需要调整的地方，请告诉我」「有问题随时告诉我」「还有什么需要我做的吗？」,
 * "Let me know if you'd like any changes", "Anything else?" — says nothing about this work and is dropped before deciding.
 * An offer of a specific next step (「要不要我也更新 README？」, "Let me know if you want me to run the migration") still asks.
 */
const SIGN_OFF_ZH = [
  /^(如果|如|若|要是)?(你|您)?(还|另外|之后)?(有|遇到)(任何|其他|别的|什么|新的)?(问题|疑问|需要|需求|想法|反馈|意见|要调整|需要调整|要修改|需要修改|要改|需要改|不清楚)(的地方|之处|的话)?[，,、\s]*(请|欢迎|可以|就|都可以)?(随时)?(再)?(告诉我|联系我|告知我?|找我|叫我|跟我说|和我说|说一声|提出来?|提出|反馈给我)[。！!~～…\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(有)?需要的话[，,\s]*(随时)?(再)?(告诉我|找我|叫我|跟我说|说一声)[。！!~～…\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^还有(什么|其他|别的|啥)(需要|要)(我)?(做|帮忙|帮你做?|处理|改|调整)?(的)?(吗|么|嘛|呢)?[？?。！!\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(还)?需要我(再)?(做|帮你做?|处理)?(点)?(什么|别的|其他)(吗|么|嘛|呢)?[？?。！!\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(随时)?(欢迎|可以)(继续)?(提问|吩咐|找我|反馈)[。！!~～…\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^希望(这些?|以上)?(对你|对您)?有(所)?帮助[。！!~～…\s]*$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
];
const GENERIC_OBJECT = /\b(any|anything|further|other|additional|more|questions?)\b/i;
function isSignOff(sentence: string): boolean {
  const text = sentence.trim();
  if (!text) return true;
  if (SIGN_OFF_ZH.some(pattern => pattern.test(text))) return true;
  if (/^(is there )?anything else\b.{0,60}$/i.test(text) || /^(any (other |more |further )?questions)\??$/i.test(text)) return true;
  if (/^(i )?hope (this|that|it) helps\b|^(i'm |i am )?(happy|glad) to help\b/i.test(text) && text.length <= 90) return true;
  // "Let me know if you'd like any changes" / "Feel free to reach out with any questions": generic, unless it offers to do something specific.
  return /^(please )?(just )?(let me know|tell me|feel free to|don't hesitate to|do not hesitate to)\b/i.test(text) && text.length <= 120
    && GENERIC_OBJECT.test(text) && !/\bme to\b/i.test(text);
}

/** A closing sentence as the rules read it (`text`: quotes, code and links masked) and as it was written (`shown`). */
interface Closing { text: string; shown: string }
const MARK = /\uE000(\d+)\uE001/g;

/** The closing sentences of a reply: its last paragraph, plus the one before when the last is only a link line; courtesy closes dropped. */
function closing(text: string, signOff: (sentence: string) => boolean = isSignOff): Closing[] {
  // Masked spans become private-use markers first, so a sentence splits the same way read masked (the rules) or with its
  // spans put back (what 快捷回复 quote in the popover).
  const spans: Array<{ mask: string; original: string }> = [];
  const mark = (mask: string) => (original: string) => `\uE000${spans.push({ mask, original }) - 1}\uE001`;
  const body = text.replace(/[\uE000\uE001]/g, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
// i18n-ignore: Internal masking tokens used by reply classifiers, never displayed.
    .replace(/`[^`\n]*`/g, mark("代码"))
    .replace(/\]\([^)\s]*\)/g, "]")
// i18n-ignore: Internal masking tokens used by reply classifiers, never displayed.
    .replace(/https?:\/\/\S+/g, mark("链接"))
// i18n-ignore: Internal masking tokens used by reply classifiers, never displayed.
    .replace(/「[^」\n]*」|“[^”\n]*”|"[^"\n]*"/g, mark("引文"));
  const masked = (sentence: string) => sentence.replace(MARK, (_, index: string) => spans[Number(index)]!.mask);
  // A link or a quote can hold a masked span of its own: put back from the outside in.
  const shown = (sentence: string) => { let out = sentence; for (let depth = 0; depth < 4 && out.includes("\uE000"); depth++) out = out.replace(MARK, (_, index: string) => spans[Number(index)]!.original); return out; };
  const blocks = body.split(/\n\s*\n/)
    .map(block => block.split("\n").filter(line => line.trim() && !/^\s*(#{1,6}\s|\||[-*_]{3,}\s*$)/.test(line)).join("\n").trim())
    .map(block => block.split(/(?<=[。！!？?；;])|(?<=[.])\s+|\n/).map(sentence => sentence.trim()).filter(Boolean) // i18n-ignore: Match original Chinese provider/user text; this is parser data.
      .map(sentence => ({ text: masked(sentence), shown: shown(sentence) })).filter(sentence => !signOff(sentence.text)))
    .filter(sentences => sentences.length > 0);
  let tail = blocks.at(-1) ?? [];
  if (blocks.length > 1 && tail.map(sentence => sentence.text).join("").replace(/[\s\p{P}\p{S}]/gu, "").length < 30) tail = [...blocks.at(-2)!, ...tail];
  // The newest 800 characters, as before: a long closing paragraph is judged by its end.
  const kept: Closing[] = [];
  for (let index = tail.length - 1, total = 0; index >= 0 && total < 800; index--) { kept.unshift(tail[index]!); total += tail[index]!.text.length; }
  return kept;
}
const closingSentences = (text: string, signOff?: (sentence: string) => boolean): string[] => closing(text, signOff).map(sentence => sentence.text);

export function replyAsksUser(text: string): boolean {
  const sentences = closingSentences(text);
  if (!sentences.length) return false;
  if (REQUEST.test(sentences.join("\n"))) return true;
  const questions = sentences.filter(sentence => /[？?][)）」"”]*$/.test(sentence)); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  if (!questions.length) return false;
  return questions.includes(sentences.at(-1)!) || questions.some(question => ASK.test(question));
}

/**
 * 快捷回复 (opus-B26): what a final reply invites, as a category only (never its text). `go-ahead`: it asks whether to
 * proceed with something specific (「要我继续吗？」, "Want me to run the migration?"); `keep-going`: it says what it will do
 * next but the turn ended there (「接下来我会…」, "Next, I'll …"). Null when it is neither.
 */
export const REPLY_NUDGES = ["go-ahead", "keep-going"] as const;
export type ReplyNudge = (typeof REPLY_NUDGES)[number];
/**
 * A quick reply. `rearm`: clear the answered turn's host attention first, so the turn it starts is announced (pushed) when
 * it ends; a hold only gets an acknowledgement back, which is not worth a notification.
 */
export interface QuickReply { key: string; text: string; tone: "green" | "amber"; icon: string; rearm: boolean }
/** What each kind of reply offers under it (`client/quick-replies.tsx`). The button says exactly what is sent. */
export let QUICK_REPLIES: Record<ReplyNudge, readonly QuickReply[]> = {
  "go-ahead": [{ key: "go", text: t("sharedReply.m004"), tone: "green", icon: "Play", rearm: true }, { key: "hold", text: t("sharedReply.m005"), tone: "amber", icon: "CirclePause", rearm: false }],
  "keep-going": [{ key: "finish", text: t("sharedReply.m006"), tone: "green", icon: "Play", rearm: true }, { key: "hold", text: t("sharedReply.m007"), tone: "amber", icon: "CirclePause", rearm: false }],
};
/** The message a quick reply sends: its button text as a sentence. */
export const quickReplyText = (reply: Pick<QuickReply, "text">) => t("sharedReply.sentence", { text: reply.text });

// Rules, not a model, and only on the closing sentences (courtesy closes dropped, quotes and code masked). A missed one costs
// a reply typed in the conversation; a wrong 「继续」 sends an Agent off doing what nobody asked. So every pattern is anchored
// to the start of a sentence or of its last clause, and anything that wants more than a yes is left alone.

/** A choice between things, information only the user has, or an opinion: 「继续」 would not answer it. */
const NEEDS_ANSWER = [
  /还是|或者|或是|二选一|哪(个|种|一|些|边|里|套|版|份|条)|选(哪|一个|一下|择)|方案\s*[A-Za-z一二三1-3]|选项|[①②③]|\b(or|either|which|whether)\b|\boption [a-z1-3]\b/i, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /(请|麻烦|需要)(你|您)?提供|(你|您)(能|可以)?提供|告诉我|发给我|发我|贴给我|贴一下|凭据|密码|密钥|口令|验证码|(你|您)(先)?(登录|扫码)|什么时候|何时|多少|几(个|点|号|天|次)|哪里|在哪|你的.{0,12}(是|在)|\b(send|tell|show|give) me\b|\b(provide|share|paste|upload)\b|\bcredentials?\b|\bpassword\b|\btoken\b|\bapi key\b|\blog ?in\b|\bsign ?in\b|\bwhat('s| is| are| was| were)?\b|\bwhere\b|\bwhen\b|\bhow (many|much|long|should|do|would)\b/i, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /你(来|自己)?(决定|定夺|拍板|看着办)|由你(来)?(决定|定|选)|你(觉得|看|认为)|怎么看|意见|想法|对吗|对不对|是吗|是不是|没错吧|理解得|看懂|看得懂|明白|清楚吗|有没有问题|有问题吗|\byour call\b|\bup to you\b|\bthink\b|\bthoughts\b|\bprefer(ence)?\b|\b(right|correct|make sense)\?$/i, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
];
/** An offer of help in general rather than of this next step. */
const GENERIC_ASK = /(其他|其它|别的|任何|更多|什么)|还有|随时|\b(anything|something) else\b|\bany\b|\b(other|further|more|additional) (changes|tweaks|adjustments|questions|help)\b/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
const PROCEED = "继续|开始|接着|动手|执行|提交|合并|合入|推送|发布|发版|部署|上线|应用|实施|落地|迁移|清理|删除|回滚|重启|运行|跑|改|修|补|加|写|更新|处理|做|推|合|发";
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
const COMMIT = "继续|开始|动手|执行|提交|合并|合入|推送|发布|发版|部署|上线|实施|迁移";
/** English work verbs, so "I'll be happy to help" or "I'll leave the PR open" never read as a next step. */
const ACTIONS = "fix|update|add|run|re-?run|write|implement|refactor|patch|change|apply|create|remove|delete|migrate|deploy|push|commit|merge|test|check|look|investigate|debug|finish|complete|handle|tackle|wire|hook|move|rename|clean|build|rebuild|install|configure|convert|port|rework|rewrite|address|resolve|split|extract|replace|bump|regenerate|verify|review|start|continue|proceed|begin|work|take|do|make|try|open|dig|trace|profile|document|draft|prepare|sync|rebase|tag|release|ship|publish|generate|scaffold|set";
/** Asking whether to go on with something specific: 「要我继续吗？」「要不要我顺手把 README 也改了？」"Shall I run the migration?". */
const GO_AHEAD_ASKS = [
  /^(那|那么|所以|另外|顺便|对了|好的?|ok)?[，,\s]*(要不要|需不需要|要|需要|是否要|是否需要)(我|我们)\S/i, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
  new RegExp(`^(那|那么|所以|好的?)?[，,\\s]*(我|我们)(现在|这就|马上|接着|继续|先|再|就|直接|可以|能)*(${PROCEED})(?!的|得).{0,40}(吗|么|嘛)[？?]`),
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
  new RegExp(`^(是否|要不要|要|现在|那就)(现在|马上|立即|直接|就|先|再|也|顺手|顺便)?(${PROCEED})(?!的|得)`),
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
  new RegExp(`^(可以|能)(${COMMIT})了?(吗|么|嘛)`),
  /^(是否|要不要|要|那就|就)(按|照)(这个|这|上面|以上|该|此|你的)?(方案|计划|思路|步骤|做法|改法|顺序)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)(也|还)?(可以|能)(帮你|顺手|顺便|再|接着|继续|一并)?.{2,60}[，,]\s*(需要|要)(吗|么|不)?[？?]$/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(so|then|also|and|ok(ay)?|great|alright)?[,\s]*(do you )?want me to\b/i,
  /^(so|then|also|and)?[,\s]*(would|do) you like me to\b/i,
  /^(so|then|also|and)?[,\s]*(shall|should) (i|we)\b/i,
  /^(can|may|could) (i|we) (go ahead|proceed|continue|start|begin|move on|now)\b/i,
  /^(is it |would it be )?(ok(ay)?|fine|alright|good)( with you)? (if i|to|for me to)\b/i,
  /^(ready|good|ok(ay)?) to (go|proceed|ship|merge|deploy|start|continue|push|release)\b/i,
  /^(proceed|continue|go ahead|ship it|merge it|deploy it|push it)\b/i,
  /^how about (i|we)\b/i,
];
/** A proposal put up for a yes: 「我先把旧接口标成 deprecated，下一版再删，好吗？」「先发预发布环境吧？」. */
const PROPOSAL = /(可以吗|好吗|行吗|成吗|可以不|好不好|行不行|可否|怎么样|如何|吧)[？?]$/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
const PROPOSAL_STEP = /(我|我们)(先|再|就|来|去|会|准备|打算|计划|接着|继续|把|直接|这就|马上|现在)|^(先|再|那就|直接|按|照|改成|换成)/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** Offering the next step on the user's word: 「如果需要，我可以顺手把 CHANGELOG 也补上。」"I can also add a test if you'd like.". */
const GO_AHEAD_OFFERS = [
  /^(如果|若|要是)?(你|您)?(需要|愿意|同意|确认|批准|点头|觉得(可以|没问题|行)|没(问题|意见))(了|后|之后)?(的话)?[，,\s]*(我|我们)(接下来|就|再|可以|来|会|马上|接着|顺手|顺便|也可以|随时可以)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)(也|还)?(可以|能)(顺手|顺便|接着|继续|再|帮你|一并|一起)?.{2,60}[，,]\s*(需要|要)(的话)?(就)?(告诉我|说一声|跟我说|吱一声)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(just )?let me know if you('d| would)? (like|want) me to\b/i,
  /^if you('d| would)? (like|want)( me to)?[,\s]+(i|we) (can|could|will|'ll)\b/i,
  /^(i|we) (can|could) (also |then |next |now |easily )?\w+.{0,120}\bif you('d| would)? (like|want)\b/i,
  /^happy to (also )?\w+.{0,120}\bif you\b/i,
  /^(just )?say (the word|go|yes)\b/i,
];
/** Saying what it does next, as the turn's last words: 「接下来我会更新接口测试。」"Next, I'll patch the key builder.". */
const KEEP_GOING = [
  /^(接下来|下一步|然后|随后|紧接着|现在|那|那么|好的?|ok)[，,：:\s]*(我|我们)(就|会|将|再|要|来|去|准备|打算|继续|开始|马上|立即|立刻|着手|动手|先)/i, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)(接下来|下一步|然后|随后|现在|马上|这就|紧接着|接着|立即|立刻|先|再)(就|会|将|再|要|来|去|继续|开始|把|处理|修|改|跑|写|补|更新|实现|检查|看|整理|排查|迁移|部署|提交)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)(会|将)(继续|接着|马上|立即|立刻|开始|着手|动手)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)来(修|改|处理|跑|写|补|看|检查|实现|更新|整理|排查)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(我|我们)(继续|接着)(把|做|处理|修|改|跑|写|补|实现|完成|迁移|更新|检查)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^让我(们)?(先|再|来|继续|接着|现在)?(看看|看一下|检查|修|改|跑|处理|补|写|更新|实现|试|排查|确认|研究|整理)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  new RegExp(`^(next|now|then|after that|afterwards|from here|so|ok(ay)?|alright|great|right)[,:]?\\s+(i('ll| will| am going to|'m going to|'m about to)|let me|we('ll| will))\\s+(now\\s+|next\\s+|go ahead and\\s+|also\\s+)?(${ACTIONS})\\b`, "i"),
  new RegExp(`^(i|we)('ll| will| am going to|'m going to|'re going to| are going to|'m about to| am about to)\\s+(now\\s+|next\\s+|then\\s+|go ahead and\\s+|proceed to\\s+|also\\s+)?(${ACTIONS})\\b`, "i"),
  new RegExp(`^let me (now |next |go ahead and |quickly |also )?(${ACTIONS})\\b`, "i"),
  /^(moving on|proceeding|continuing|next up)\b/i,
  /^(now|next|then)[,]?\s+(i|we) (need|have) to\b/i,
];
/**
 * Not going on now: waiting for the user, a later check, monitoring, stopping on purpose, or a refusal; or a next step that
 * waits for something first (「CI 通过后合并」「等审批通过再部署」"merge once CI is green"), which 「继续做完」 would skip.
 */
const NOT_ONWARD = /等(你|您)|你(确认|同意|回复|批准|提供|决定|看过|看完)(后|之后|以后|了)|(如果|若|要是)(你|您)|到时|届时|稍后再|过(一)?会(儿)?再|下次|之后再|明天|今晚|回头|改天|\d{1,2}[:：点]\d{0,2}|关注|观察|盯(着|一下)|监控|留意|跟踪|汇报|回报|通知你|告诉你|同步给你|先到这|到此为止|暂停|停(在|下|止)|(先|暂|就|也)?不(会|再|用|需要|动|改|继续|做|处理)|别(动|改)|无需|不必|(通过|完成|跑完|结束|成功|就绪|变绿|审批|批准)(之?后|以后)|等.{0,16}(再|之后|后)|等待|\b(wait(ing)?|until|once you|after you|when you|if you|your (reply|confirmation|approval|go-ahead|input|answer))\b|\b(after|later|tomorrow|tonight|in \d+ (sec|min|hour|hr|day)|at \d{1,2}(:\d\d)?\s*(am|pm)?\b|again at|check back|report back|let you know|keep you posted|follow up|ping you|monitor|keep an eye|watch)\b|\b(as soon as|when)\b|(?<!\b(at|all at) )\bonce\b(?!\s+(more|again)\b)|\b(stop|pause|wrap up|leave|hold off|be (happy|glad|around|here|available)|discuss|talk|chat)\b|\b(won't|will not|don't|do not|not going to|no need|nothing (more|else))\b/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** A courtesy close the reply rules keep but a quick reply never answers: "…any other changes, just let me know — happy to help". */
const courtesy = (sentence: string) => isSignOff(sentence) || (GENERIC_ASK.test(sentence)
  && /\b(let me know|happy to help|glad to help|feel free|reach out|don't hesitate|do not hesitate)\b|告诉我|找我|叫我|说一声|联系我|帮忙/i.test(sentence)); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** Done already, or only possible, not next: 「我先把关键部分整理出来了。」「然后我们就可以上线」. */
const DONE = /已经|了[。！!～~…]*$|(我|我们)(就|也|还)?(可以|能够|能)/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
const plain = (sentence: string) => sentence.replace(/[*_~]+/g, "").replace(/^\s*([-+•]|\d+[.)、])\s+/, "").trim();
const asks = (sentence: string) => /[？?][)）」"”]*$/.test(sentence) || /(吗|嘛)$/.test(sentence); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** The sentence and its last clause: 「测试都过了，要提交吗？」 is judged by 「要提交吗？」 too. */
function clauses(sentence: string): string[] {
  const last = sentence.split(/[，,；;：:—–]\s*|\s+-\s+/).map(part => part.trim()).filter(Boolean).at(-1); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  return last && last !== sentence ? [sentence, last] : [sentence];
}
const needsAnswer = (sentence: string) => NEEDS_ANSWER.some(pattern => pattern.test(sentence));
function goAheadAsk(sentence: string): boolean {
  if (!asks(sentence) || sentence.length > 200 || needsAnswer(sentence) || GENERIC_ASK.test(sentence)) return false;
  if (PROPOSAL.test(sentence) && PROPOSAL_STEP.test(sentence)) return true;
  return clauses(sentence).some(part => part.length <= 120 && GO_AHEAD_ASKS.some(pattern => pattern.test(part)));
}
function goAheadOffer(sentence: string): boolean {
  if (asks(sentence) || sentence.length > 200 || needsAnswer(sentence) || GENERIC_ASK.test(sentence)) return false;
  return clauses(sentence).some(part => GO_AHEAD_OFFERS.some(pattern => pattern.test(part)));
}
function keepGoing(sentence: string): boolean {
  if (asks(sentence) || sentence.length > 200 || NOT_ONWARD.test(sentence) || REQUEST.test(sentence) || DONE.test(sentence)) return false;
  return clauses(sentence).some(part => KEEP_GOING.some(pattern => pattern.test(part)));
}

/** What a reply invites, and the closing sentence that decided it, as written. */
function invitation(text: string | null | undefined): { nudge: ReplyNudge; sentence: string } | null {
  if (!text?.trim()) return null;
  const closings = closing(text, courtesy).map(sentence => ({ text: plain(sentence.text), shown: sentence.shown })).filter(sentence => sentence.text);
  const sentences = closings.map(sentence => sentence.text), last = sentences.at(-1);
  if (!last) return null;
  const questions = sentences.filter(asks);
  // go-ahead: the closing question (or the one just before a short remark) asks to go on, and every question here does.
  const asking = goAheadAsk(last) ? sentences.length - 1
    : sentences.length > 1 && !asks(last) && last.length <= 60 && !needsAnswer(last) && !REQUEST.test(last) && goAheadAsk(sentences.at(-2)!) ? sentences.length - 2 : -1;
  if (asking >= 0 && questions.every(goAheadAsk)) return { nudge: "go-ahead", sentence: closings[asking]!.shown };
  if (!questions.length && goAheadOffer(last)) return { nudge: "go-ahead", sentence: closings.at(-1)!.shown };
  // keep-going: nothing is asked, and the turn's last words announce the next step.
  return !questions.length && keepGoing(last) ? { nudge: "keep-going", sentence: closings.at(-1)!.shown } : null;
}

export function replyNudge(text: string | null | undefined): ReplyNudge | null {
  return invitation(text)?.nudge ?? null;
}

const QUOTE_MAX = 120;
/**
 * The closing sentence `replyNudge` decided on, as written (quotes, code and links put back), on one line of at most 120
 * characters; null when the reply invites nothing. The popover quotes it above its 快捷回复, so a tap agrees to something the
 * user can see (P2-1). The server masks credentials in it before it leaves (server/attention.ts `noteAsk`); never stored.
 */
export function nudgeSentence(text: string | null | undefined): string | null {
  const found = invitation(text);
  if (!found) return null;
  const line = found.sentence.replace(/\*\*|__|~~/g, "").replace(/^\s*([-+•]|\d+[.)、])\s+/, "").replace(/\s+/g, " ").trim(), chars = Array.from(line);
  return line ? chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX - 1).join("")}…` : line : null;
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  QUICK_REPLIES = {
  "go-ahead": [{ key: "go", text: t("sharedReply.m004"), tone: "green", icon: "Play", rearm: true }, { key: "hold", text: t("sharedReply.m005"), tone: "amber", icon: "CirclePause", rearm: false }],
  "keep-going": [{ key: "finish", text: t("sharedReply.m006"), tone: "green", icon: "Play", rearm: true }, { key: "hold", text: t("sharedReply.m007"), tone: "amber", icon: "CirclePause", rearm: false }],
};
});
