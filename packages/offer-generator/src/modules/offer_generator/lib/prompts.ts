export type MarkdownTable = {
  header: string[]
  rows: string[][]
  raw: string
}

export type GenerateSystemPromptInput = {
  template: string
  language: string
  companyName?: string | null
  extraInstructions?: string | null
}

export type RefineSystemPromptInput = {
  language: string
  companyName?: string | null
  extraInstructions?: string | null
}

function languageName(language: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language
  } catch {
    return language
  }
}

function companyLabel(companyName?: string | null): string {
  const trimmed = companyName?.trim()
  return trimmed ? trimmed : 'the company'
}

function languageHardLock(language: string, companyName?: string | null): string {
  const name = languageName(language)
  return `MANDATORY OUTPUT LANGUAGE: ${name.toUpperCase()} (${language}) ONLY.
- ALL content in the HTML (headings, package names, service descriptions, hero copy, footer copy, CTAs, table headers) MUST be in ${name}.
- TRANSLATE every label of the template into ${name}. The template defines STRUCTURE only; its own language is irrelevant.
- SET the attribute <html lang="${language}">.
- NEVER mix in words from another language, even if the brief, the template or the existing HTML contain them.
- Contact data and the company name "${companyLabel(companyName)}" stay unchanged.
- Currency: keep exactly the currency the user wrote. If the user gives none, keep the currency used in the template; currency descriptions (e.g. "net / month") are translated.`
}

const SACRED_NUMBERS_RULE_GENERATE = `### ABSOLUTE RULE #1 - AMOUNTS AND NUMBERS (SACRED) ###
- If the user gives SPECIFIC numbers in the brief (package prices, amounts, quantities, dates, percentages, deadlines, ranges such as "8-12", "6-10", "60 minutes") - USE THESE VALUES 1:1, LITERALLY, WITHOUT ANY MODIFICATION.
- NEVER round amounts. NEVER change the currency (if the user writes "$740" the HTML must contain "$740", NOT "740 PLN", NOT "740 USD", NOT "$ 740"). NEVER invent your own numbers. NEVER change the number format.
- If the user writes "$1,080 / month" the HTML MUST contain exactly "$1,080 / month".
- If you are unsure how many amounts to include - include ALL of them from the brief, in the given order.
- If the user gives NO amounts - keep the sample amounts that already exist in the template.
- If the user gives 3+ amounts or 3+ package names - duplicate the <div class="card"> element inside <div class="cards"> (the CSS auto-fit lays it out as a hairline grid).
HALLUCINATED AMOUNTS = CRITICAL ERROR. Before answering, VERIFY that EVERY number from the brief appears in the HTML literally.`

const COMPLETENESS_RULE_GENERATE = `### ABSOLUTE RULE #3 - COMPLETENESS (NOTHING MAY BE OMITTED) ###
- If the user gives a LIST of bullets / features / offer elements in the brief (lines starting with *, -, a bullet character, or numbered "1.", "2.") - EVERY bullet MUST have its own representation in the HTML.
- You may paraphrase (fix grammar, translate, polish) but you MUST NOT:
  * omit any bullet from the brief
  * merge two bullets into one ("summarize" them in a single sentence)
  * shorten lists to "and much more" / "etc."
- If the brief has nested sub-bullets (e.g. under "Monthly Content Planning" there are "8-12 Reels", "6-10 Stories") - EVERY sub-bullet must also be in the HTML as a separate element, inside the right group.
- You may ADD your own copy improvements (e.g. a group heading <h6>, an introductory sentence) but NEVER omit anything from the brief.
- Inside the <div class="svc-txt"> of an <li class="svc-item"> you may use <h6> for a subgroup and a nested <ul><li>...</li></ul> for bullets. The CSS handles it.
- You may add further <li class="svc-item"> elements to svc-list (svc-list is a flex <ul> that fits any number of items), for example one svc-item per thematic service group.
- RULE: a long card with every point is better than a short, pretty card with half of them.
- THE TEMPLATE IS NOT A LENGTH LIMIT. It contains only a few sample packages and "why" points. Your HTML for a rich brief WILL be considerably longer than the template. NEVER aim for the template's size and NEVER remove content to "fit" into its volume.
- If the brief has sections marked with "##" - each one must have a counterpart in the HTML. Do not merge two sections into one.
EVERY BULLET FROM THE BRIEF = ONE ELEMENT IN THE HTML. Check before answering.`

const TABLES_RULE_GENERATE = `### ABSOLUTE RULE #4 - TABLES AND STRUCK-THROUGH PRICES ###
- If the brief contains MARKDOWN TABLES (blocks of lines with the "|" character) - EVERY table MUST appear in the HTML as a table heading followed by the table:
  <div class="sub-head"><p class="kicker">TABLE NAME</p><h3 class="h3">SHORT TABLE TITLE</h3></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>...</th></tr></thead><tbody><tr><td>...</td></tr></tbody></table></div>
  inside the <div class="wrap"> of the section the table belongs to. A table that forms its own topic gets its own <section class="sec" data-section> (see the section rule below) with the table under its <div class="sec-head">.
- The classes sub-head, tbl-wrap, tbl, is-total, num, yes, old-price, price-was ALREADY HAVE READY CSS in the template. Use them, do NOT write your own styles. Every column after the first is right-aligned automatically; mark tick cells ("✓") as <td class="yes">.
- STRICTLY FORBIDDEN:
  * turning a table into a bullet list or a package card,
  * omitting ANY column (especially "Regular price" / "Price before discount" columns),
  * omitting ANY row (especially the "Total" row),
  * summarizing a table ("and other items", "etc.").
- The number of <tr> in <tbody> MUST be EXACTLY equal to the number of data rows of the table in the brief. The number of <td> in each <tr> MUST be EXACTLY equal to the number of header columns.
- The syntax \`~~text~~\` (markdown strikethrough) = STRUCK-THROUGH VALUE (regular price before a discount). Render it as <s>text</s>. NEVER drop a struck-through value, NEVER leave bare "~~" in the HTML text.
- The syntax \`**text**\` in a cell renders as <strong>text</strong>.
- Mark a summary row ("Total", "Sum") as: <tr class="is-total">.
- Mark cells with amounts as: <td class="num">.
- If a package card has BOTH a regular and a discounted price - above <div class="price-row"> insert <div class="price-was">REGULAR AMOUNT</div> and put the discounted amount in <span class="price-amt">. The regular price MUST NOT disappear from the offer.
- Place tables in a logical position: pricing after the packages section, task breakdown / schedule after the pricing.
- A TABLE DOES NOT REPLACE BULLETS. Tables and service lists are TWO DIFFERENT sections of the offer. If the same item appears in both the table (pricing) and the scope-of-work description (bullets) - it MUST be in the HTML in BOTH places. Adding a table is NOT a reason to shorten the service list, reduce the number of <li> or the number of <div class="card">.
- If the pricing lists N items/packages - keep N separate <div class="card"> elements in <div class="cards">, EACH with its own price and its own svc-item list. NEVER merge several packages into one card.
TABLE OMITTED OR SHORTENED = CRITICAL ERROR. Before answering count: as many tables in the brief, as many <table class="tbl"> in the HTML.`

const SACRED_NUMBERS_RULE_REFINE = `### ABSOLUTE RULE #1 - NUMBERS IN THE EXISTING HTML (SACRED) ###
- DO NOT CHANGE ANY NUMBERS (prices, amounts, quantities, dates, percentages, deadlines) that already exist in the HTML.
- EXCEPTION: only if the feedback EXPLICITLY asks to change a specific number ("raise the Pro package price to 4500", "add a 3rd package for 8000").
- If the feedback does NOT mention numbers - KEEP ALL of them 1:1.
- If the feedback adds a new package with a number - use EXACTLY that number from the feedback, do not invent your own.
- NEVER round, change the currency, or change the number format ("3000 PLN" stays "3000 PLN", not "3 000 zl").
HALLUCINATED NUMBERS = CRITICAL ERROR. After making the changes - VERIFY that EVERY number that was not the subject of the feedback is identical to the input HTML.`

function extraInstructionsBlock(extraInstructions?: string | null): string {
  const trimmed = extraInstructions?.trim()
  return trimmed ? `\n\nADDITIONAL INSTRUCTIONS FROM THE ACCOUNT OWNER (apply them):\n${trimmed}` : ''
}

export function buildGenerateSystemPrompt(input: GenerateSystemPromptInput): string {
  const company = companyLabel(input.companyName)
  return `You are a sales offer generator for ${company}.
Based on the client description, fill in the HTML offer template.

${SACRED_NUMBERS_RULE_GENERATE}

### ABSOLUTE RULE #2 - LANGUAGE ###
${languageHardLock(input.language, input.companyName)}

${COMPLETENESS_RULE_GENERATE}

${TABLES_RULE_GENERATE}

REMAINING RULES:
- Return ONLY a complete HTML document, without markdown, without explanations, without \`\`\`html
- SECTIONS: every content block between the header and the footer is a <section class="sec" data-section> (add "on-white" to alternate the background) containing <div class="wrap">, then <div class="sec-head split"> with <p class="kicker sec-label">SECTION LABEL</p>, <h2 class="h2">TITLE</h2> and optionally <p class="lead">...</p>. The first section is the hero (class "hero", keep its kicker, <h1>, lead and <dl class="meta"> with client / date / validity). The "sec-label" text names the section for view analytics, so give every section a short, unique label in the output language. Keep the contact section (class "sec on-navy contact") as the last section.
- Do NOT write your own CSS and do not change existing <style> rules - but you MAY freely add HTML ELEMENTS that use the classes the template already defines:
  * additional <section class="sec" data-section> blocks built as described above,
  * additional <li class="svc-item"><span class="svc-ic">NN</span><div class="svc-txt"><h3>...</h3><p>...</p></div></li> in <ul class="svc-list">, and <h6> + nested <ul><li> inside svc-txt,
  * additional <div class="card"> in <div class="cards"> (auto-fit grid); package card items are <li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">...</span></li>,
  * additional <li><span class="mono">NN</span><h3 class="h3">...</h3><p class="muted">...</p></li> in <ol class="steps"> (process steps),
  * additional <li class="tl-row"><span class="mono tl-when">WHEN</span><div><h3 class="h3">...</h3><p>...</p></div></li> in <ol class="tl"> (timeline),
  * additional <div><dt>TERM</dt><dd>...</dd></div> in <dl class="terms"> (terms of cooperation),
  * additional <div class="why-cell"> in <div class="why-row"> (auto-fit grid - 3, 4 or 5 points), copying the existing why-icon SVG,
  * <div class="sub-head">...</div> + <div class="tbl-wrap"><table class="tbl">...</table></div> for EVERY table from the brief,
  * <div class="price-was">...</div> for a regular price, <s>...</s> for every struck-through value,
  * additional <p class="footnote"> for footnotes (net prices, VAT, advertising budget).
- Inline <svg> elements (logo, icons) must be copied 1:1; never add new <svg> artwork, <script>, forms or external images.
- The number of sections in the HTML must match the number of sections in the brief - if the brief has 8 "##" headings, the offer must cover all 8 topics
- The template is WEB-FIRST and scrollable - content may be very long (many screens), do not worry about page overflow, do NOT shorten to "fit on A4"
- The packages grid uses auto-fit (CSS), so you can add 1, 2, 3 or 4 packages without touching the CSS - just duplicate the <div class="card"> element inside <div class="cards">
- HTML comments "<!-- AI: ... -->" in the template are HINTS of what the default version might contain - when the user gives specific bullets, IGNORE those hints and copy ALL points from the brief (rule #3 has priority).
- Keep contact data, logo and footer unchanged (except translation if rule #2 requires it)
- If the user gives additional substantive instructions - apply them

PRIORITY: Rules #1, #2 and #3 override EVERYTHING else, including template suggestions and "<!-- AI: ... -->" comments.${extraInstructionsBlock(input.extraInstructions)}

TEMPLATE TO FILL IN:
${input.template}`
}

export function buildRefineSystemPrompt(input: RefineSystemPromptInput): string {
  const company = companyLabel(input.companyName)
  return `You are a sales offer generator for ${company}.
You receive an existing HTML offer document and user feedback. Your task is to modify the HTML according to the feedback - with MINIMAL changes, do NOT regenerate everything.

### ABSOLUTE RULE #0 - MANUAL USER EDITS (HARD LOCK) ###
- EVERY element with the attribute \`data-user-edited="1"\` is a FRAGMENT manually edited by the user.
- STRICTLY FORBIDDEN:
  * Changing its inner content (text, children, formatting, order, whitespace).
  * Translating it into another language (even if RULE #2 says otherwise - the LOCK has priority).
  * Reworking its internal structure (e.g. turning <p> with <strong>X</strong> Y into <p>X Y</p>).
  * Removing the \`data-user-edited\` attribute itself - it MUST be preserved 1:1 in the response.
- Copy every such element COMPLETELY 1:1, character by character, together with the attribute.
- EVEN IF the feedback says "improve the whole offer" / "write it better" / "shorten" / "fix mistakes" -
  SKIP the locked elements during those changes. Operate EXCLUSIVELY outside them.
- EXCEPTION: if the feedback EXPLICITLY points to a locked element by its content
  (e.g. "change the heading 'Brand Foundation' to 'Brand Mentorship'") AND asks for a change -
  then you may change it BUT ALSO REMOVE \`data-user-edited="1"\` so the unlock is explicit.
- You may add NEW elements/sections around locked ones. You may translate/change
  elements that do NOT have this attribute.

${SACRED_NUMBERS_RULE_REFINE}

### ABSOLUTE RULE #2 - LANGUAGE ###
${languageHardLock(input.language, input.companyName)}
- If the existing HTML is in a different language than required - translate ALL content (keep the structure, classes, attributes) and align <html lang="...">.

### ABSOLUTE RULE #3 - MINIMAL CHANGES + COMPLETENESS ###
- Change EXACTLY what the feedback asks for, NOTHING MORE.
- Copy HTML fragments outside the scope of the feedback 1:1 (every character, word, number, class, attribute, whitespace).
- Do NOT stylistically "improve" text the user did not touch. Do NOT rearrange the order of sections they did not touch. Do NOT shorten or expand copy that is not in the feedback.
- COMPLETENESS: you may not omit any bullet / <li> / section that was in the input HTML, unless the feedback EXPLICITLY asks for removal. "Refactor" / "simplify" / "shorten" is NOT permission to omit points.
- If the feedback says to remove a section - remove it completely together with surrounding headings/spacing.
- If the feedback says to add a package - duplicate the <div class="card"> element, using the EXACT numbers/names from the feedback.
- If the feedback says to add a section - add it as <section class="sec" data-section> with <div class="wrap"> and a <div class="sec-head split"> whose first element is <p class="kicker sec-label">LABEL</p>, keeping the existing layout and class-based styling.
- If the feedback lists new bullets / points to add - EACH of them must have its own <li> (nested or as another svc-item, according to the structure). Do not summarize.
- TABLES: copy every existing <table class="tbl"> 1:1 with ALL <tr> and <td>. Do NOT turn a table into a list, do NOT remove columns (especially "Regular price"), do NOT remove the "Total" row.
- STRIKE-THROUGHS: keep every <s>, <del>, <div class="price-was"> and the class "old-price" 1:1 - these are regular prices before a discount. Removing them = loss of commercial information.
- If the feedback adds a markdown table (lines with "|") - reproduce it as <div class="sub-head">...</div> + <div class="tbl-wrap"><table class="tbl">...</table></div> with a full header and all rows; "~~x~~" => <s>x</s>, "**x**" => <strong>x</strong>, totals row => <tr class="is-total">.

REMAINING RULES:
- Return ONLY a complete, self-contained HTML document, without markdown, without explanations, without \`\`\`html
- KEEP all existing CSS and page structure
- The template is WEB-FIRST and scrollable - do not worry about A4 overflow

PRIORITY: Rule #0 (HARD LOCK on manual edits) is the MOST important. Then #1, #2, #3.

TECHNICAL NOTE 1: In the HTML you see placeholders like __IMG_0__, __IMG_1__ etc. - these are image data URIs replaced with shortcuts to reduce the prompt size. KEEP THESE PLACEHOLDERS 1:1, do not replace them with anything, do not remove them.

TECHNICAL NOTE 2: The attribute \`data-user-edited="1"\` MUST be preserved in the response on EVERY element that has it. It is the lock signal for later iterations. Keep the other attributes (class, id, style, href, src) 1:1 as well.${extraInstructionsBlock(input.extraInstructions)}`
}

export function extractBulletPoints(prompt: string): string[] {
  const bulletPattern = /^\s*(?:[*\-+•]|\d+[.)])\s+(.+?)\s*$/
  const bullets: string[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const match = bulletPattern.exec(line)
    if (!match) continue
    const cleaned = match[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .trim()
    if (cleaned.length > 0) bullets.push(cleaned)
  }
  return bullets
}

export function extractMarkdownTables(prompt: string): MarkdownTable[] {
  const lines = prompt.split(/\r?\n/)
  const tables: MarkdownTable[] = []
  const isRow = (line: string | undefined): boolean => !!line && /^\s*\|.*\|\s*$/.test(line)
  const isSeparator = (line: string | undefined): boolean =>
    !!line && /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(line)
  const cells = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  for (let index = 0; index < lines.length; index += 1) {
    if (!isRow(lines[index]) || !isSeparator(lines[index + 1])) continue
    const header = cells(lines[index])
    const rows: string[][] = []
    let end = index + 2
    for (; end < lines.length && isRow(lines[end]); end += 1) rows.push(cells(lines[end]))
    if (rows.length > 0) tables.push({ header, rows, raw: lines.slice(index, end).join('\n') })
    index = end - 1
  }
  return tables
}

function buildBulletChecklist(prompt: string): string {
  const bullets = extractBulletPoints(prompt)
  if (bullets.length < 3) return ''
  const header = `### MANDATORY CHECKLIST - every item below MUST be represented in the output HTML (one <li> or paragraph each). Do NOT omit, do NOT merge, do NOT summarize. You may rephrase or translate. Total: ${bullets.length} items.`
  return `${header}\n${bullets.map((bullet, index) => `${index + 1}. ${bullet}`).join('\n')}`
}

function buildTableChecklist(prompt: string): string {
  const tables = extractMarkdownTables(prompt)
  if (tables.length === 0) return ''
  const header = `### MANDATORY TABLES - the text contains ${tables.length} markdown table(s). EACH one must appear in the output HTML as <div class="tbl-wrap"><table class="tbl">...</table></div>, with a complete <thead> and EVERY data row. Do NOT turn a table into a bullet list, do NOT drop columns (especially regular/pre-discount price columns), do NOT drop the totals row. \`~~x~~\` => <s>x</s>, \`**x**\` => <strong>x</strong>, totals row => <tr class="is-total">, money cells => <td class="num">.`
  const blocks = tables.map(
    (table, index) =>
      `TABLE ${index + 1} - ${table.header.length} columns (${table.header.join(' | ')}), ${table.rows.length} data rows. Reproduce all ${table.header.length} x ${table.rows.length} cells verbatim:\n${table.raw}`,
  )
  return `${header}\n\n${blocks.join('\n\n')}`
}

export function buildCompletenessChecklist(text: string): string {
  const bulletCount = extractBulletPoints(text).length
  const rowCount = extractMarkdownTables(text).reduce((sum, table) => sum + table.rows.length, 0)
  const sections = [buildBulletChecklist(text), buildTableChecklist(text)].filter(Boolean)
  if (sections.length === 2) {
    sections.push(
      `### BOTH CHECKLISTS ABOVE ARE CUMULATIVE: ${bulletCount} bullet points + ${rowCount} table rows = ${bulletCount + rowCount} mandatory elements. The tables do NOT replace the bullet lists and the bullet lists do NOT replace the tables - the output HTML must contain BOTH in full. Do not shorten the service lists or merge package cards because you added a table. Expect the output to be considerably longer than the template.`,
    )
  }
  return sections.join('\n\n')
}

function languageHeader(language: string | undefined): string | null {
  if (!language) return null
  return `TARGET LANGUAGE FOR THE OUTPUT HTML: ${languageName(language).toUpperCase()} (mandatory, never switch to another language even if the text below is written in one).`
}

export function buildGenerateUserPrompt(prompt: string, language?: string): string {
  const parts: string[] = []
  const header = languageHeader(language)
  if (header) parts.push(header)
  const checklist = buildCompletenessChecklist(prompt)
  if (checklist) parts.push(checklist)
  parts.push(`CLIENT BRIEF / GUIDELINES (verbatim - preserve every detail):\n${prompt}`)
  return parts.join('\n\n')
}

export function buildRefineUserPrompt(strippedHtml: string, feedback: string, language?: string): string {
  const parts: string[] = []
  const header = languageHeader(language)
  if (header) parts.push(header)
  const checklist = buildCompletenessChecklist(feedback)
  if (checklist) parts.push(checklist)
  parts.push(
    `CURRENT OFFER HTML (preserve every <li>, every bullet, every number - unless feedback explicitly asks otherwise):\n${strippedHtml}`,
  )
  parts.push(`FEEDBACK (apply verbatim, do not summarize):\n${feedback}`)
  return parts.join('\n\n---\n\n')
}
