/**
 * ייבוא לידים מקובץ Excel ל-Supabase.
 * שימוש: node scripts/import-excel.js path/to/file.xlsx [path2.xlsx ...]
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseExcelBuffer } = require("../src/excelImport");
const { bulkInsertLeads, getExistingLeadPhones } = require("../src/db");

async function importFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`קובץ לא נמצא: ${abs}`);
  }

  const buffer = fs.readFileSync(abs);
  const { leads, errors } = parseExcelBuffer(buffer);
  const existing = await getExistingLeadPhones();
  const toInsert = [];
  let skipped = 0;

  for (const lead of leads) {
    if (existing.has(lead.phone)) {
      skipped++;
      continue;
    }
    existing.add(lead.phone);
    toInsert.push(lead);
  }

  const inserted = await bulkInsertLeads(toInsert);

  return {
    file: path.basename(abs),
    parsed: leads.length,
    inserted: inserted.length,
    skipped,
    parseErrors: errors,
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("שימוש: node scripts/import-excel.js <file.xlsx> [file2.xlsx ...]");
    process.exit(1);
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const f of files) {
    try {
      const result = await importFile(f);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      console.log(`\n📄 ${result.file}`);
      console.log(`   נקראו: ${result.parsed} | נוספו: ${result.inserted} | דולגו (כפול): ${result.skipped}`);
      if (result.parseErrors.length) {
        console.log(`   שגיאות פרסור: ${result.parseErrors.length}`);
        for (const e of result.parseErrors.slice(0, 5)) {
          console.log(`     - שורה ${e.row} (${e.sheet}): ${e.error}`);
        }
        if (result.parseErrors.length > 5) {
          console.log(`     ... ועוד ${result.parseErrors.length - 5}`);
        }
      }
    } catch (err) {
      console.error(`❌ ${f}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n✅ סה"כ נוספו ${totalInserted} לידים, דולגו ${totalSkipped} כפולים`);
}

main();
