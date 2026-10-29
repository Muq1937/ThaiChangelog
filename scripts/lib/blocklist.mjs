// Hard no's, enforced in code rather than left to the model: every headline is checked
// before the model sees it, and everything the model writes is checked again.
// Over-blocking is fine (there are always more stories than slots). Never loosen the
// monarchy section.

// English: regex fragments matched as whole words, case-insensitive.
const EN = [
  // monarchy
  "kings?", "queens?", "royals?", "royalty", "monarch\\w*", "majesty", "l[eè]se[- ]majest\\w*",
  "crown prince", "princes?", "princess\\w*", "palace\\w*", "coronation", "regent", "throne",
  "vajiralongkorn", "bhumibol", "sirikit", "suthida", "chakri", "(?:article|section) 112",
  // politics, military, conflict
  "prime minister", "premier", "ministers?", "ministry", "elections?", "electoral", "parliament\\w*",
  "senat\\w*", "mps?", "politic\\w*", "coups?", "protest\\w*", "cabinet", "constitution\\w*",
  "pheu thai", "bhumjaithai", "people.s party", "democrat party", "thaksin", "paetongtarn",
  "shinawatra", "anutin", "srettha", "prayut", "chadchart", "opposition",
  "junta", "military", "army", "soldiers?", "troops?", "wars?",
  "ceasefire", "border clash\\w*", "cambodia\\w*", "myanmar",
  // crime, scams, tragedy
  "police\\w*", "cops?", "arrest\\w*", "suspects?", "crim\\w*", "murder\\w*", "kill\\w*", "dead",
  "deaths?", "died", "dies", "dying", "corpse", "shoot\\w*", "shot", "guns?", "gunman", "stab\\w*",
  "rap(?:e|ed|es|ist)", "assault\\w*", "abduct\\w*", "kidnap\\w*", "drugs?", "meth", "narcotic\\w*",
  "scam\\w*", "fraud\\w*", "call cent(?:re|er)s?", "gambl\\w*", "brib\\w*", "corrupt\\w*",
  "smuggl\\w*", "traffick\\w*", "courts?", "judge", "verdict", "jail\\w*", "prison\\w*", "sentenced",
  "lawsuit\\w*", "sued", "accident\\w*", "crash\\w*", "collision", "drown\\w*", "suicide",
  "injur\\w*", "victims?", "missing", "evacuat\\w*", "casualt\\w*",
  // disasters and safety incidents
  "landslides?", "flash floods?", "disasters?", "emergency", "stranded",
  // celebrity gossip ("spotted together" is left to the prompt: leopards get spotted together too)
  "dating", "rumou?rs?", "affair", "divorc\\w*",
];

// Harmless phrases that contain a blocked English word.
const EN_ALLOW = ["king cobra", "king prawn", "king crab", "king mackerel", "queen bee", "food court"];

// Thai is written without spaces between words, so these match as substrings.
// Avoid short terms that hide inside everyday words (ดับ in ระดับ, คุก in คุกกี้, ศาล in ศาลเจ้า).
const TH = [
  // monarchy and royal vocabulary
  "พระราช", "พระบรม", "ในหลวง", "สมเด็จพระ", "เจ้าฟ้า", "พระองค์", "ราชวงศ์", "ราชสกุล",
  "พระเจ้าอยู่หัว", "พระมหากษัตริย์", "กษัตริย์", "ราชินี", "ทรงพระ", "โปรดเกล้า", "ทูลเกล้า",
  "เสด็จ", "พยุหยาตรา", "ชลมารค", "ถวายพระพร", "หม่อมเจ้า", "หมิ่นสถาบัน", "ม.112", "มาตรา 112",
  "รัชกาล", "ร.9", "ร.10",
  // politics, military, conflict
  "นายกรัฐมนตรี", "นายกฯ", "รัฐมนตรี", "รมว.", "รมช.", "ครม.", "รัฐบาล", "ส.ส.", "สส.", "ส.ว.", "สว.",
  "รัฐสภา", "เลือกตั้ง", "พรรค", "การเมือง", "ศาลรัฐธรรมนูญ", "รัฐประหาร", "ชุมนุม", "ประท้วง",
  "ม็อบ", "ทักษิณ", "แพทองธาร", "ชินวัตร", "อนุทิน", "เศรษฐา", "ประยุทธ์", "พิธา", "ชัชชาติ",
  "เพื่อไทย", "ภูมิใจไทย", "ประชาธิปัตย์", "ฝ่ายค้าน", "ซักฟอก", "ม.157",
  "กองทัพ", "ทหาร", "ชายแดน", "สงคราม", "สู้รบ", "ปะทะ", "เมียนมา", "กัมพูชา",
  // crime, scams, tragedy
  "ตำรวจ", "สภ.", "ผบ.ตร", "จับกุม", "หมายจับ", "มอบตัว", "ผู้ต้องหา", "ผู้ต้องสงสัย", "คนร้าย", "โจร", "ปล้น",
  "รัวหมัด", "รุมต่อย", "โดนรุม", "ถูกรุม",
  "ขโมย", "ลักทรัพย์", "ฆ่า", "ฆาตกรรม", "ศพ", "เสียชีวิต", "ตาย", "ยิงปืน", "ถูกยิง", "ยิงดับ",
  "กระสุน", "ถูกแทง", "แทงดับ", "ทำร้าย", "ข่มขืน", "อนาจาร", "ลวนลาม", "ล่วงละเมิด", "หื่น",
  "ยาเสพติด", "ยาบ้า", "มิจฉาชีพ", "หลอก", "แก๊งคอล", "คอลเซ็นเตอร์", "ฉ้อโกง", "โกง", "ทุจริต",
  "คอร์รัปชัน", "สินบน", "พนัน", "ค้ามนุษย์", "ลักลอบ", "ศาลอาญา", "ศาลฎีกา", "ศาลแพ่ง",
  "ศาลปกครอง", "ศาลจังหวัด", "พิพากษา", "ฟ้อง", "ติดคุก", "จำคุก", "เรือนจำ", "อุบัติเหตุ",
  "รถชน", "รถคว่ำ", "จมน้ำ", "ไฟไหม้", "เพลิงไหม้", "บาดเจ็บ", "สูญหาย", "อพยพ",
  // disasters and safety incidents (ระทึก, "nerve-wracking", heads most incident reports)
  "ระทึก", "น้ำป่า", "ดินถล่ม", "ดินสไลด์", "อุทกภัย", "ผู้ประสบภัย", "เยียวยา", "น้ำท่วมหนัก",
  "จมมิด", "จมบาดาล", "ภัยพิบัติ",
  // celebrity gossip
  "คบหา", "เลิกรา", "หย่า", "มือที่สาม",
];

// Place names that contain a blocked Thai term (สมุทรสงคราม, the Amphawa province, contains สงคราม).
const TH_ALLOW = ["สมุทรสงคราม"];

const EN_RE = new RegExp(`\\b(?:${EN.join("|")})\\b`, "i");

/** Returns the first blocked term found in `text`, or null if the text is clean. */
export function blockedTerm(text) {
  let t = String(text ?? "").normalize("NFC").replace(/[​-‍﻿]/g, "");
  let en = t.toLowerCase();
  for (const phrase of EN_ALLOW) en = en.replaceAll(phrase, " ");
  const hit = en.match(EN_RE);
  if (hit) return hit[0];
  for (const phrase of TH_ALLOW) t = t.replaceAll(phrase, " ");
  return TH.find((term) => t.includes(term)) ?? null;
}
