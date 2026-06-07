const XLSX = require("xlsx");
const { extractMessageName } = require("./leadMessageName");

/**
 * מנרמל מספר טלפון לפורמט WhatsApp: ספרות בלבד + קידומת מדינה.
 */
function normalizePhone(raw) {
  let phone = String(raw || "").replace(/\D/g, "");
  if (!phone) return null;
  if (phone.startsWith("0")) {
    phone = "972" + phone.slice(1);
  }
  return phone;
}

function pickField(row, keys) {
  for (const key of keys) {
    const val = row[key];
    if (val != null && String(val).trim() !== "") {
      return String(val).trim();
    }
  }
  return "";
}

function buildNotes(row) {
  const parts = [];
  const city = pickField(row, ["City", "city", "עיר"]);
  const address = pickField(row, ["Address", "address", "כתובת"]);
  const rating = pickField(row, ["Rating", "rating", "דירוג"]);
  const reviews = pickField(row, ["Reviews", "reviews", "ביקורות"]);
  const instagram = pickField(row, ["Instagram", "instagram", "אינסטגרם"]);

  if (city) parts.push(`עיר: ${city}`);
  if (address) parts.push(`כתובת: ${address}`);
  if (rating) parts.push(`דירוג: ${rating}`);
  if (reviews) parts.push(`ביקורות: ${reviews}`);
  if (instagram && instagram !== "—" && instagram !== "-") {
    parts.push(`אינסטגרם: ${instagram}`);
  }
  return parts.join(" | ");
}

/**
 * ממיר שורות מאקסל לרשומות leads.
 * תומך בעמודות: Name, Phone, City, Address, Rating, Reviews, Instagram (או בעברית).
 */
function parseExcelBuffer(buffer, options = {}) {
  const businessType = options.businessType || "סלון ציפורניים";
  const source = options.source || "excel-import";

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const leads = [];
  const errors = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const business = pickField(row, ["Name", "name", "שם", "Business", "business", "שם העסק"]);
      const phoneRaw = pickField(row, ["Phone", "phone", "טלפון", "Mobile", "mobile"]);
      const phone = normalizePhone(phoneRaw);

      if (!business && !phoneRaw) continue;

      if (!business) {
        errors.push({ sheet: sheetName, row: rowNum, error: "חסר שם עסק" });
        continue;
      }
      if (!phone) {
        errors.push({
          sheet: sheetName,
          row: rowNum,
          error: `מספר טלפון לא תקין: ${phoneRaw || "(ריק)"}`,
        });
        continue;
      }

      leads.push({
        name: business,
        business,
        phone,
        business_type: businessType,
        notes: buildNotes(row),
        source,
        message_name: extractMessageName(business),
      });
    }
  }

  return { leads, errors };
}

module.exports = { parseExcelBuffer, normalizePhone };
