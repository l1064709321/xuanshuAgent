/**
 * src/scripts/test_verifier.ts — 辅助验收机制自测（P1 验收脚本）
 *
 * 目的：证明「Generator-Verifier」里的 Verifier 真的会判负，而不是摆设。
 * 用例设计原则：每条用例都必须能区分「真交付」与「假交付」。
 *
 * 运行：npm run test:verifier   （退出码 0=全部通过，1=有失败用例）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { verifyChildResult, verifySelfCheck, formatVerdictBrief, detectCapabilities } from '../core/verifier.js';

interface Case {
  name: string;
  agent: string;
  task: string;
  answer: string;
  /** 期望：是否通过 */
  expectOk: boolean;
  /** 期望命中的问题码（任一命中即算） */
  expectCodes?: string[];
}

const results: { name: string; pass: boolean; detail: string }[] = [];

function sh(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000 }, (err) => resolve(!err));
  });
}

async function runCase(c: Case): Promise<void> {
  const v = await verifyChildResult({ agent: c.agent, task: c.task, answer: c.answer, pool: null, llmReview: false });
  const codes = v.issues.map((i) => i.code);
  const okMatch = v.ok === c.expectOk;
  const codeMatch = !c.expectCodes || c.expectCodes.some((x) => codes.includes(x));
  const pass = okMatch && codeMatch;
  results.push({
    name: c.name,
    pass,
    detail: `${pass ? 'PASS' : 'FAIL'} 期望ok=${c.expectOk} 实际ok=${v.ok} | issues=[${codes.join(',') || '无'}] | degraded=[${v.degraded.length}]`,
  });
  console.log(`\n── ${c.name} ──  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(formatVerdictBrief(v));
}

async function main(): Promise<void> {
  console.log('════ 玄姝 · 辅助验收机制自测 ════\n');
  console.log(await verifySelfCheck(null));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsverify_test_'));
  const realFile = path.join(tmp, 'real_output.txt');
  fs.writeFileSync(realFile, '真实产物内容\n');
  const emptyFile = path.join(tmp, 'empty_output.txt');
  fs.writeFileSync(emptyFile, '');
  const missingFile = path.join(tmp, 'not_exist_report.md');

  // ── 用例 1：编造产物（宣称已生成，磁盘不存在）→ 必须判负
  await runCase({
    name: '用例1 编造产物',
    agent: '文件Agent',
    task: '生成一份分析报告',
    answer: `我已完成分析报告，已生成并保存到：${missingFile}\n共 3 个章节，内容完整。`,
    expectOk: false,
    expectCodes: ['ARTIFACT_MISSING'],
  });

  // ── 用例 2：产物为空文件 → 必须判负
  await runCase({
    name: '用例2 空产物',
    agent: '文件Agent',
    task: '导出数据到文件',
    answer: `数据已导出，输出路径：${emptyFile}`,
    expectOk: false,
    expectCodes: ['ARTIFACT_EMPTY'],
  });

  // ── 用例 3：产物真实落盘 → 必须通过
  await runCase({
    name: '用例3 真实产物',
    agent: '文件Agent',
    task: '写出结果文件',
    answer: `已生成并保存到：${realFile}`,
    expectOk: true,
  });

  // ── 用例 4：代码宣称输出与真实 stdout 不符 → 必须判负
  await runCase({
    name: '用例4 编造运行结果',
    agent: '代码Agent',
    task: '写一个函数算 1+1 并输出',
    answer: [
      '已运行验证通过，结果如下：',
      '```python',
      'def add(a, b):',
      '    return a + b',
      'if __name__ == "__main__":',
      '    print(add(1, 1))',
      '```',
      '输出：999',
    ].join('\n'),
    expectOk: false,
    expectCodes: ['CODE_CLAIM_MISMATCH'],
  });

  // ── 用例 5：代码真实可运行且输出一致 → 必须通过
  await runCase({
    name: '用例5 代码真实可运行',
    agent: '代码Agent',
    task: '写一个函数算 1+1 并输出',
    answer: [
      '已运行验证通过：',
      '```python',
      'def add(a, b):',
      '    return a + b',
      'if __name__ == "__main__":',
      '    print(add(1, 1))',
      '```',
      '输出：2',
    ].join('\n'),
    expectOk: true,
  });

  // ── 用例 6：代码运行报错 → 必须判负
  await runCase({
    name: '用例6 代码运行报错',
    agent: '代码Agent',
    task: '写一段能跑通的代码',
    answer: ['```python', 'raise ValueError("boom")', '```'].join('\n'),
    expectOk: false,
    expectCodes: ['CODE_RUN_FAIL'],
  });

  // ── 用例 7：代码含未实现占位 → 必须判负
  await runCase({
    name: '用例7 代码占位未实现',
    agent: '代码Agent',
    task: '实现一个爬虫',
    answer: ['```python', 'def crawl():', '    # TODO: 待实现', '    pass', '```'].join('\n'),
    expectOk: false,
    expectCodes: ['CODE_STUB'],
  });

  // ── 用例 8：引用链接全部不可达 → 必须判负
  await runCase({
    name: '用例8 引用死链',
    agent: '搜索Agent',
    task: '查一下最新资讯',
    answer: '根据资料 https://this-domain-should-not-exist-9z8x7c.invalid/a 与 https://another-fake-9z8x7c.invalid/b ，结论已确认。',
    expectOk: false,
    expectCodes: ['SOURCE_ALL_DEAD'],
  });

  // ── 用例 9/10：媒体真实性（静帧 vs 真实动态视频）
  const staticMp4 = path.join(tmp, 'static.mp4');
  const movingMp4 = path.join(tmp, 'moving.mp4');
  const caps = await detectCapabilities();
  const FF = caps.ffmpeg ?? '';
  if (!FF) console.log('\n⚠️ 未探测到 ffmpeg，媒体用例将跳过');
  const canStatic = FF
    ? await sh(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3', '-pix_fmt', 'yuv420p', staticMp4])
    : false;
  const canMoving = FF
    ? await sh(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=3', '-pix_fmt', 'yuv420p', movingMp4])
    : false;

  if (canStatic) {
    await runCase({
      name: '用例9 静态帧冒充视频',
      agent: '视频Agent',
      task: '生成一段宣传视频',
      answer: `视频已生成，输出：${staticMp4}`,
      expectOk: false,
      expectCodes: ['MEDIA_STATIC_FRAMES', 'MEDIA_BLACK_FRAMES', 'MEDIA_NEAR_STATIC'],
    });
  } else {
    console.log('\n── 用例9 跳过：无 ffmpeg，无法生成测试视频');
  }

  if (canMoving) {
    await runCase({
      name: '用例10 真实动态视频',
      agent: '视频Agent',
      task: '生成一段宣传视频',
      answer: `视频已生成，输出：${movingMp4}`,
      expectOk: true,
    });
  } else {
    console.log('\n── 用例10 跳过：无 ffmpeg，无法生成测试视频');
  }

  // ── 用例 11：视频画面无任何文字，但任务明确要求文案 → 必须判负（未体现文案）
  if (canMoving) {
    await runCase({
      name: '用例11 视频缺要求文案',
      agent: '视频Agent',
      task: '生成视频，文案：「限时五折抢购，全场包邮」',
      answer: `视频已生成，输出：${movingMp4}`,
      expectOk: false,
      expectCodes: ['MEDIA_COPY_MISSING', 'MEDIA_COPY_MISMATCH', 'MEDIA_COPY_UNVERIFIED'],
    });
  }

  // ── 用例 12/13：画面文字 OCR 正/负样本（证明 OCR 真在读字，非一律判负/判过）
  const font = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
  const mkTextFrames = async (dir: string, text: string): Promise<boolean> => {
    fs.mkdirSync(dir, { recursive: true });
    const py = `
from PIL import Image, ImageDraw, ImageFont
import os, json
d, text, font = ${JSON.stringify(dir)}, ${JSON.stringify(text)}, ${JSON.stringify(font)}
f = ImageFont.truetype(font, 22)
for i in range(10):
    im = Image.new("RGB", (480, 160), "white")
    dr = ImageDraw.Draw(im)
    dr.text((15, 68), text, fill="black", font=f)
    dr.rectangle([440, 20 + i * 10, 470, 45 + i * 10], fill="red")
    im.save(os.path.join(d, "f_%02d.png" % i))
print("ok")
`;
    const r = await sh('python3', ['-c', py]);
    return r && fs.existsSync(path.join(dir, 'f_09.png'));
  };
  const mkTextVideo = async (name: string, text: string): Promise<string> => {
    const dir = path.join(tmp, `frames_${name}`);
    const out = path.join(tmp, `${name}.mp4`);
    if (!(await mkTextFrames(dir, text))) return '';
    const ok = await sh(FF, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', '5', '-i', path.join(dir, 'f_%02d.png'),
      '-pix_fmt', 'yuv420p', out,
    ]);
    return ok ? out : '';
  };

  if (FF) {
    const goodCopy = 'LIMITED OFFER 50 FREE SHIPPING';
    const goodMp4 = await mkTextVideo('goodcopy', goodCopy);
    if (goodMp4) {
      await runCase({
        name: '用例12 画面文案一致',
        agent: '视频Agent',
        task: `生成视频，文案：「${goodCopy}」`,
        answer: `视频已生成，输出：${goodMp4}`,
        expectOk: true,
      });
    } else {
      console.log('\n── 用例12 跳过：测试视频生成失败');
    }

    const badMp4 = await mkTextVideo('badcopy', 'WINTER SALE 20 OFF TODAY');
    if (badMp4) {
      await runCase({
        name: '用例13 画面文案错版',
        agent: '视频Agent',
        task: `生成视频，文案：「${goodCopy}」`,
        answer: `视频已生成，输出：${badMp4}`,
        expectOk: false,
        expectCodes: ['MEDIA_COPY_MISMATCH', 'MEDIA_COPY_WEAK', 'MEDIA_COPY_UNVERIFIED'],
      });
    } else {
      console.log('\n── 用例13 跳过：测试视频生成失败');
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  // ── 汇总
  console.log('\n════ 用例汇总 ════');
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}\n      ${r.detail}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自测脚本异常:', e);
  process.exit(1);
});
