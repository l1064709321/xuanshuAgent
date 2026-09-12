/**
 * src/web/speakable.ts — Markdown 正文 → TTS 朗读用口语文本
 *
 * 朗读只念气泡里的"话"：Markdown 语法标记（#、**、`、| 等）、围栏代码块、
 * 缩进代码块、表格、链接地址一律不念，避免把 ``` 和代码本体逐字读出来。
 */

const CODE_NOTE = "代码块内容跳过。";
const TABLE_NOTE = "表格内容跳过。";

/** 把 Markdown 全文转换为可直接送 TTS 的口语文本 */
export function toSpeakable(md: string): string {
  const src = (md || "").replace(/\r\n?/g, "\n");
  const kept: string[] = [];
  let inFence = false;
  let fenceMark = "";
  let inTable = false;
  let inIndentCode = false;
  let prevBlank = true;

  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const fenceM = line.match(/^\s*(`{3,}|~{3,})/);

    // 围栏代码块：整段丢弃，仅留一句提示
    if (fenceM) {
      if (!inFence) {
        inFence = true;
        fenceMark = fenceM[1][0];
      } else if (fenceM[1][0] === fenceMark) {
        inFence = false;
        kept.push(CODE_NOTE);
      }
      prevBlank = false;
      continue;
    }
    if (inFence) continue;

    // 缩进代码块（4 空格 / Tab，且前一行是空行）
    const isIndentCodeLine = /^(\s{4,}|\t)\S/.test(rawLine);
    if (isIndentCodeLine && prevBlank && !inIndentCode) {
      inIndentCode = true;
    }
    if (inIndentCode) {
      if (!isIndentCodeLine && line.trim() !== "") {
        inIndentCode = false;
        kept.push(CODE_NOTE);
      } else {
        prevBlank = false;
        continue;
      }
    }

    // GFM 表格：连续以 | 开头的行整体跳过
    if (/^\s*\|/.test(line)) {
      inTable = true;
      prevBlank = false;
      continue;
    }
    if (inTable) {
      inTable = false;
      kept.push(TABLE_NOTE);
    }

    kept.push(line);
    prevBlank = line.trim() === "";
  }
  if (inFence) kept.push(CODE_NOTE);
  if (inTable) kept.push(TABLE_NOTE);
  if (inIndentCode) kept.push(CODE_NOTE);

  return tidy(kept.join("\n"));
}

/** 行内语法清理 + 空白归一 */
function tidy(s: string): string {
  let t = s;

  // 控制标记（工具调用/询问卡片等，不朗读）
  t = t.replace(/\[(ASK|PERM|VERIFY|TASK|TOOL|DONE)[:\s][^\]]*\]/gi, " ");
  t = t.replace(/\[\[[^\]]*\]\]/g, " ");

  // 图片整体丢弃；链接只留可见文字
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // 行内代码去掉反引号，保留文字
  t = t.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");
  t = t.replace(/`/g, "");

  // 块级标记
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");                 // 标题
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");                      // 引用
  t = t.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, "");        // 列表项
  t = t.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "");           // 分隔线
  t = t.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, "");      // 表格残留

  // 强调 / 删除线
  t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  t = t.replace(/(^|[\s(（])\*([^*\n]+)\*(?=[\s).,，。！？!?、）]|$)/g, "$1$2");
  t = t.replace(/(^|[\s(（])_([^_\n]+)_(?=[\s).,，。！？!?、）]|$)/g, "$1$2");
  t = t.replace(/~~([^~\n]+)~~/g, "$1");
  t = t.replace(/^[ \t]*[*_]{1,3}[ \t]*$/gm, "");

  // HTML 标签 / 残留管道符 / 裸链接
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/\|/g, " ");
  t = t.replace(/https?:\/\/\S+/g, "链接");

  // Emoji 与装饰性符号（TTS 会念成奇怪的字）
  t = t.replace(
    /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu,
    "",
  );

  // 空白归一
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]*\n[ \t]*/g, "\n");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/(代码块内容跳过。\s*){2,}/g, CODE_NOTE);
  t = t.replace(/(表格内容跳过。\s*){2,}/g, TABLE_NOTE);

  return t.trim();
}
