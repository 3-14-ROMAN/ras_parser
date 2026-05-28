#!/usr/bin/env node
/**
 * embed/batch.smoke.mjs — sanity check для batched /embed:
 *   embed(["A"])[0]  vs  embed(["A","B","C","D"])[0]
 *
 * Гипотеза: при батчинге каждый текст обрабатывается изолированно
 * (attention-маска не пересекает границы текстов), поэтому multivector[i]
 * и dense_vectors[i] должны быть идентичны одиночному прогону с точностью
 * до float-noise.
 *
 * Если cosine между «батч[i]» и «одиночка» < THRESHOLD — это баг
 * (либо в Jina, либо в нашем разборе ответа). Падаем fail-loud.
 *
 * Запуск: node --env-file=.env embed/batch.smoke.mjs
 */

import "../network/loadEnv.js";
import { embedTexts } from "./clients.js";

const COSINE_THRESHOLD = 0.9999; // float noise — fp16 ≈ 1e-4, fp32 ≈ 1e-6

// Реальные legal-куски разной длины (≈100, ≈400, ≈800, ≈1200 символов).
const TEXTS = [
  "Решением Арбитражного суда от 15.03.2024 в удовлетворении исковых требований ООО «Альфа» к ООО «Бета» о взыскании задолженности в размере 1 200 000 рублей по договору поставки № 42/23 от 01.06.2023 отказано в полном объёме.",
  "Постановлением Седьмого арбитражного апелляционного суда от 28.06.2024 решение Арбитражного суда Новосибирской области от 12.02.2024 по делу № А45-7891/2023 оставлено без изменения, апелляционная жалоба ООО «Стройторг» — без удовлетворения. Суд первой инстанции пришёл к обоснованному выводу о том, что ответчик допустил существенное нарушение договорных обязательств в части сроков поставки.",
  "Постановление Арбитражного суда Уральского округа от 15.09.2024 по делу № А60-25634/2023. Кассационная инстанция оставила в силе постановление апелляции, констатировав, что нижестоящими судами правильно применены положения статей 506, 513, 521 Гражданского кодекса Российской Федерации, регулирующие отношения по договору поставки. Доводы заявителя жалобы о ненадлежащей оценке доказательств не нашли подтверждения. Согласно представленным товарным накладным и актам сверки взаимных расчётов, ответчик систематически нарушал согласованные графики отгрузки, что в совокупности повлекло срыв производственного цикла истца.",
  "Решением Арбитражного суда города Москвы от 18.11.2024 по делу № А40-156234/2024 удовлетворены исковые требования АО «Промышленная компания» к ООО «Логистика+» о взыскании 4 856 320 рублей основного долга, 482 145 рублей договорной неустойки, 78 920 рублей процентов за пользование чужими денежными средствами. Суд установил, что между сторонами 12.01.2024 был заключён договор поставки оборудования № ПК-12/24, по условиям которого истец обязался поставить ответчику комплект промышленного оборудования общей стоимостью 8 миллионов рублей с условием 60% предоплаты и 40% оплаты в течение 30 дней с момента подписания акта приёма-передачи. Истец полностью исполнил свои обязательства, поставив оборудование 25.02.2024, что подтверждается подписанным сторонами УПД № 187. Ответчик в установленный срок оплату не произвёл, обязательства по договору не исполнил, на досудебные претензии не отреагировал. Доводы ответчика об отсутствии у него финансовой возможности оплатить поставленное оборудование судом отклонены, поскольку финансовое положение должника не освобождает его от исполнения денежных обязательств. Суд также учёл условия пункта 7.3 договора, предусматривающего начисление неустойки в размере 0,1% за каждый день просрочки.",
];

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error(`cosine: shape mismatch a=${a?.length} b=${b?.length}`);
  }
  let dot = 0;
  let na  = 0;
  let nb  = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

function multivectorCosineMean(mvA, mvB) {
  // Multivector — массив векторов по токенам. Сравним среднее cosine по позициям.
  if (mvA.length !== mvB.length) {
    throw new Error(`multivector shape mismatch: ${mvA.length} vs ${mvB.length}`);
  }
  let sum = 0;
  for (let i = 0; i < mvA.length; i += 1) {
    sum += cosine(mvA[i], mvB[i]);
  }
  return sum / mvA.length;
}

async function main() {
  console.log("[smoke] step 1: embed each text individually (baseline)");
  const singles = [];
  for (let i = 0; i < TEXTS.length; i += 1) {
    const out = await embedTexts([TEXTS[i]], { task: "retrieval.passage", returnSparse: true });
    singles.push({
      dense:   out.dense_vectors[0],
      colbert: out.multivectors[0],
      tokens:  out.token_counts[0],
    });
    console.log(`  [single ${i}] tokens=${singles[i].tokens} dense_dim=${singles[i].dense.length} mv=${singles[i].colbert.length}x${singles[i].colbert[0]?.length ?? 0}`);
  }

  console.log("\n[smoke] step 2: embed all texts as a batch");
  const batched = await embedTexts(TEXTS, { task: "retrieval.passage", returnSparse: true });
  for (let i = 0; i < TEXTS.length; i += 1) {
    console.log(`  [batch ${i}] tokens=${batched.token_counts[i]} dense_dim=${batched.dense_vectors[i].length} mv=${batched.multivectors[i].length}x${batched.multivectors[i][0]?.length ?? 0}`);
  }

  console.log("\n[smoke] step 3: cosine compare single vs batch");
  let allPass = true;
  for (let i = 0; i < TEXTS.length; i += 1) {
    const denseCos = cosine(singles[i].dense, batched.dense_vectors[i]);
    const mvCos    = multivectorCosineMean(singles[i].colbert, batched.multivectors[i]);
    const denseOK  = denseCos >= COSINE_THRESHOLD;
    const mvOK     = mvCos    >= COSINE_THRESHOLD;
    const tokenOK  = singles[i].tokens === batched.token_counts[i];
    const verdict  = denseOK && mvOK && tokenOK ? "✅ PASS" : "❌ FAIL";
    console.log(
      `  [${i}] dense_cos=${denseCos.toFixed(8)} mv_cos=${mvCos.toFixed(8)} ` +
      `tokens single=${singles[i].tokens} batch=${batched.token_counts[i]} ${verdict}`,
    );
    if (!denseOK || !mvOK || !tokenOK) allPass = false;
  }

  if (!allPass) {
    console.error("\n[smoke] FAIL — batched embedding diverges from single. Не катить!");
    process.exit(1);
  }
  console.log("\n[smoke] OK — batched embedding идентичен одиночному (cosine ≥ " + COSINE_THRESHOLD + ").");
}

main().catch((e) => {
  console.error(`[smoke] FATAL ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
