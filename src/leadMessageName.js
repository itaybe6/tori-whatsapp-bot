const BUSINESS_STOPWORDS = new Set([
  "לק",
  "גל",
  "ג'ל",
  "סלון",
  "סטודיו",
  "ביוטי",
  "beauty",
  "studio",
  "nails",
  "nail",
  "spa",
  "בניית",
  "ציפורניים",
  "עיצוב",
  "מכון",
  "קוסמטיקה",
  "קליניקה",
  "מספרה",
  "מניקור",
  "פדיקור",
  "אופקים",
  "באופקים",
  "the",
  "and",
  "by",
  "of",
  "my",
  "your",
]);

const KNOWN_LATIN_NAMES = {
  tina: "טינה",
  tania: "טניה",
  tanya: "טניה",
  maayan: "מעיין",
  maya: "מאיה",
  mayan: "מעיין",
  sarah: "שרה",
  sara: "שרה",
  dana: "דנה",
  noa: "נועה",
  noah: "נועה",
  yael: "יעל",
  michal: "מיכל",
  shira: "שירה",
  hila: "הילה",
  gal: "גל",
  tal: "טל",
  roni: "רוני",
  ronit: "רונית",
  oshrat: "אושרת",
  liat: "ליאת",
  orly: "אורלי",
  vered: "וורד",
  esther: "אסתר",
  rivka: "רבקה",
  rachel: "רחל",
  leah: "לאה",
  anna: "אנה",
  anat: "ענת",
  irit: "עירית",
  sigal: "סיגל",
  chen: "חן",
  bar: "בר",
  mor: "מור",
  shani: "שני",
  adi: "עדי",
  rotem: "רותם",
  inbal: "ענבל",
  limor: "לימור",
  einat: "עינת",
  omer: "עומר",
  yuval: "יובל",
  nir: "ניר",
  idan: "עידן",
  alon: "אלון",
  amir: "אמיר",
  david: "דוד",
  daniel: "דניאל",
  michael: "מיכאל",
  yosef: "יוסף",
  moshe: "משה",
};

const ENGLISH_BUSINESS_WORDS = new Set([
  "beauty",
  "studio",
  "salon",
  "nail",
  "nails",
  "spa",
  "gel",
  "lacquer",
  "by",
  "the",
  "and",
  "my",
  "your",
  "professional",
  "pro",
  "center",
  "centre",
  "shop",
  "store",
]);

function isHebrewStopword(word) {
  const clean = word.replace(/['"]/g, "");
  if (!clean || clean.length < 2) return true;
  if (BUSINESS_STOPWORDS.has(clean)) return true;
  if (/^ב[\u05d0-\u05ea]{2,}ים$/.test(clean)) return true;
  if (/^(לק|ג.?ל|סטודיו|ביוטי|סלון)/i.test(clean)) return true;
  return false;
}

function extractHebrewFirstName(segment) {
  const words = segment.match(/[\u0590-\u05FF][\u0590-\u05FF'"]*/g) || [];
  for (const word of words) {
    const clean = word.replace(/['"]/g, "");
    if (!isHebrewStopword(clean)) return clean;
  }
  return "";
}

function transliterateLatinName(word) {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!lower) return "";
  if (KNOWN_LATIN_NAMES[lower]) return KNOWN_LATIN_NAMES[lower];

  let heb = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const next = lower[i + 1];
    const pair = ch + (next || "");

    if (pair === "ch") {
      heb += "צ";
      i++;
      continue;
    }
    if (pair === "sh") {
      heb += "ש";
      i++;
      continue;
    }
    if (pair === "th") {
      heb += "ת";
      i++;
      continue;
    }
    if (pair === "ph") {
      heb += "פ";
      i++;
      continue;
    }
    if (ch === "t" && next === "i") {
      heb += "ט";
      continue;
    }
    if (ch === "a" && i === lower.length - 1) {
      heb += "ה";
      continue;
    }
    if (ch === "e" && i === lower.length - 1) continue;
    if (ch === "i" && next === "a") {
      heb += "יה";
      i++;
      continue;
    }
    if (ch === "i" && next === "e") {
      heb += "י";
      i++;
      continue;
    }

    const map = {
      a: "א",
      b: "ב",
      c: "ק",
      d: "ד",
      e: "ה",
      f: "פ",
      g: "ג",
      h: "ה",
      i: "י",
      j: "ג",
      k: "ק",
      l: "ל",
      m: "מ",
      n: "נ",
      o: "ו",
      p: "פ",
      q: "ק",
      r: "ר",
      s: "ס",
      t: "ט",
      u: "ו",
      v: "ו",
      w: "ו",
      x: "קס",
      y: "י",
      z: "ז",
    };
    if (map[ch]) heb += map[ch];
  }

  return heb || word;
}

function extractEnglishFirstName(segment) {
  const words = segment
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const candidates = words.filter(
    (w) => !ENGLISH_BUSINESS_WORDS.has(w.toLowerCase())
  );
  if (!candidates.length) return "";
  return transliterateLatinName(candidates[0]);
}

/**
 * מחלץ שם פרטי בעברית לשליחת הודעה מתוך שם העסק.
 */
function extractMessageName(business) {
  const text = String(business || "").trim();
  if (!text) return "";

  const segments = text.split(/\s*[|–—-]\s*/).map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    if (/[\u0590-\u05FF]/.test(segment)) {
      const name = extractHebrewFirstName(segment);
      if (name) return name;
    }
  }

  for (const segment of segments) {
    if (/[a-zA-Z]/.test(segment)) {
      const name = extractEnglishFirstName(segment);
      if (name) return name;
    }
  }

  return extractHebrewFirstName(text) || extractEnglishFirstName(text) || "";
}

module.exports = { extractMessageName };
