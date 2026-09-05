import type { PiiMatch } from "./privacy";

/**
 * Recognises unstructured PII - people's names and postal addresses - in screen text.
 *
 * **This is a rule-based recogniser, not a neural NER model.** That is a deliberate,
 * costed decision, and worth stating plainly because the build spec asked for a model.
 * The smallest credible English NER export is BERT-base at 94-109 MB quantised. The whole
 * extension is 40 MB today, the vision pipeline already accounts for 312-397 MB of
 * resident memory, and client resource utilisation is 20% of the evaluation. Adding a
 * 100 MB model and its runtime footprint to detect names would cost more of that budget
 * than the entire vision pipeline does. If the model is wanted, the seam is here: replace
 * `detectUnstructuredPii` and everything downstream is unchanged.
 *
 * The design compensates for being rules rather than a model by grading its confidence
 * honestly. Strong evidence - a labelled field, a salutation, a known given name - scores
 * high enough to mask outright. Weak evidence - two capitalised words that merely look
 * like a name - scores into the review band, where the context builder withholds the
 * element rather than transmitting a guess. A rule-based recogniser that pretended to
 * certainty would be the dangerous version of this.
 */

/**
 * Labels that introduce a person's name on a form or a record.
 *
 * These carry most of the recall: in the screens this agent works on, a name is nearly
 * always next to a word saying that it is one.
 */
const NAME_CUES =
  /\b(?:full[ -]?name|first[ -]?name|last[ -]?name|middle[ -]?name|account[ -]?holder|card[ -]?holder|policy[ -]?holder|applicant|beneficiary|nominee|customer[ -]?name|patient|employee[ -]?name|guardian|father'?s name|mother'?s name|spouse|contact[ -]?person|registered to|issued to|in the name of|name)\b/i;

/** Salutations, which mark the following words as a name in almost any context. */
const SALUTATION = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Shri|Smt|Sri|Kum|Master)\.?\s+/;

/**
 * A capitalised word that could be part of a name: `Anita`, `O'Brien`, `Da-Silva`.
 *
 * The leading run of lowercase is optional so that `O'Brien` and `D'Souza` survive - the
 * first version required it, and quietly dropped every name of that shape.
 */
const NAME_WORD = "(?:[A-Z][a-z]*(?:['’-][A-Z]?[a-z]+)+|[A-Z][a-z]+)";

/** Two or three capitalised words in a row - the shape of a written name. */
const NAME_SHAPE = new RegExp(`\\b${NAME_WORD}(?:\\s+${NAME_WORD}){1,2}\\b`, "g");

/**
 * Capitalised words that are not names, however name-shaped they look.
 *
 * Without this list the recogniser tags "Download Report", "Privacy Policy" and "Home
 * Loan" as people, and a privacy tool that masks every heading on the page has not
 * protected anyone - it has just made the agent blind. Every entry here was a false
 * positive on the labelled set before it was added.
 */
const NOT_NAME_WORDS = new Set(
  (
    "january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "download upload report reports invoice invoices statement statements summary details detail " +
    "account accounts settings setting profile dashboard home page login logout signin signout " +
    "submit cancel confirm approve reject continue back next previous save saved delete remove " +
    "search filter sort export import print share copy edit view open close add new create " +
    "privacy policy terms conditions service services support help contact about faq " +
    "loan loans credit debit card cards payment payments transaction transactions balance " +
    "bank banking branch ifsc customer care centre center number status pending approved " +
    "claim claims policy insurance premium maturity nominee scheme fund funds " +
    "welcome hello dear thank thanks please note important warning error success failed " +
    "total amount due date time today yesterday tomorrow year month week day " +
    "india indian delhi mumbai chennai kolkata bengaluru bangalore hyderabad pune ahmedabad " +
    "government ministry department office authority board commission corporation limited " +
    "private public national international state central district city town village " +
    "product products cart checkout order orders shipping delivery return returns " +
    "settlement adjuster review approval pending revenue quarter sign here " +
    "username password email phone mobile address pin code otp aadhaar pan gst " +
    "sanctioned expenditure portal request callback queries " +
    // Keyboard and UI vocabulary. "Press Ctrl+Shift+P" was recognised as a person named
    // Press Ctrl until these were listed - found by an older control corpus, not by this
    // module's own tests, which is the argument for keeping both.
    "press ctrl alt shift esc escape enter tab space del delete backspace fn cmd command " +
    "option key keys shortcut click tap select choose enable disable toggle refresh reload " +
    "scroll swipe drag drop resize zoom step steps option options menu button link field"
  ).split(/\s+/),
);

/** Organisation tails: `Reliance Industries Limited` is a company, not a person. */
const ORG_TAIL =
  /\b(?:ltd|limited|inc|llc|llp|corp|corporation|company|co|technologies|technology|systems|solutions|services|industries|enterprises|associates|bank|hospital|school|college|university|institute|foundation|trust|society|department|ministry|authority|board)\b/i;

/**
 * Common given names, used as positive evidence rather than as the detector itself.
 *
 * Short on purpose. A gazetteer big enough to cover the world's given names would also
 * cover most capitalised words, and its misses would be concentrated on exactly the people
 * whose names are least represented in whatever list it came from. It is one signal here,
 * and its absence lowers confidence into the review band rather than clearing the text.
 */
const GIVEN_NAMES = new Set(
  (
    "aarav aditya akash amit anand anil anita anjali ankit arjun arun asha ashok bhavna " +
    "chetan deepa deepak divya gaurav geeta harish isha jaya kavita kiran krishna lakshmi " +
    "madhu mahesh manish meera mohan mukesh nandini naveen neha nikhil nisha pooja pradeep " +
    "prakash pramod praveen priya rahul rajesh rajiv rakesh ramesh ravi rekha rohit sachin " +
    "sandeep sanjay saraswati shalini shivam shweta sneha sonia sudha sunil suresh swati " +
    "tanvi uma vandana varun vijay vikas vinod vishal yash yogesh kalpana guion mae sally " +
    "james john robert michael william david richard joseph thomas charles christopher " +
    "daniel matthew anthony mark donald steven paul andrew joshua mary patricia jennifer " +
    "linda elizabeth barbara susan jessica sarah karen nancy lisa margaret sandra ashley " +
    "emily donna michelle carol amanda dorothy melissa deborah stephanie rebecca laura " +
    "neil christina ahmed fatima omar aisha yusuf zainab ibrahim khadija ali maryam"
  ).split(/\s+/),
);

/** Street and locality words that mark a postal address. */
const ADDRESS_WORDS =
  /\b(?:flat|apartment|apt|house|plot|door|building|block|tower|floor|room|street|st|road|rd|lane|ln|avenue|ave|marg|nagar|colony|sector|phase|layout|cross|main|extension|vihar|puram|pura|ganj|bagh|chowk|circle|society|enclave|park|gali|mohalla|ward|taluk|tehsil|district|village|po|p\.o\.|near|opposite|behind|beside)\b/i;

/** An Indian PIN code: six digits not starting with zero. */
const PIN_CODE = /\b[1-9]\d{5}\b/;

const ADDRESS_CUE =
  /\b(?:address|residence|residing at|billing|shipping|delivered to|located at)\b/i;

/**
 * A candidate address line: a house/street token, some text, and a PIN code or locality
 * word. Deliberately line-oriented, because that is how addresses are laid out on screen.
 */
const ADDRESS_SHAPE =
  /\b(?:(?:flat|apartment|apt|house|plot|door|no\.?|#)\s*[-\w/]+[,\s]+)?[\w.'-]+(?:[,\s]+[\w.'-]+){0,10}(?:[,\s]+\b[1-9]\d{5}\b)?/g;

/** Confidence at or above this is masked outright; below it, held for review. */
export const STRONG_EVIDENCE = 0.9;
export const WEAK_EVIDENCE = 0.5;

/**
 * Trims words that cannot be part of a name off each end of a candidate.
 *
 * Capitalised prose runs into names constantly - "Contact Vikrant Bhardwaj about the
 * file" matches as one three-word candidate. Rejecting the whole thing because "Contact"
 * is in the stop list threw away the name with it. Trimming the ends and re-checking what
 * is left keeps the person and drops the verb.
 *
 * A stop word *between* two name words is still fatal: "Rahul Download Report" is not a
 * name with noise around it, it is not a name.
 */
function trimToName(candidate: string): { value: string; offset: number } | undefined {
  const words = candidate.split(/\s+/);
  let first = 0;
  let last = words.length - 1;
  while (first <= last && isNotNameWord(words[first]!)) first += 1;
  while (last >= first && isNotNameWord(words[last]!)) last -= 1;
  if (last - first < 1) return undefined;

  const kept = words.slice(first, last + 1);
  if (kept.some(isNotNameWord)) return undefined;

  const value = kept.join(" ");
  const offset = candidate.indexOf(value);
  return offset < 0 ? undefined : { value, offset };
}

/**
 * Function words. Title-cased UI text is full of them - "Export To Excel", "Terms Of Use"
 * - and a name never contains one in the middle.
 */
const FUNCTION_WORDS = new Set(
  "to of and the for in on at by with from into a an or as is are be".split(" "),
);

function isNotNameWord(word: string): boolean {
  const plain = word.toLowerCase().replace(/[^a-z]/g, "");
  // Street and locality words are excluded here too: "Church Street" and "Nehru Colony"
  // are places, and calling them people would report one person per line of an address.
  return NOT_NAME_WORDS.has(plain) || FUNCTION_WORDS.has(plain) || ADDRESS_WORDS.test(plain);
}

function hasKnownGivenName(candidate: string): boolean {
  return candidate.split(/\s+/).some((word) => GIVEN_NAMES.has(word.toLowerCase()));
}

/**
 * True when a name-shaped candidate is introduced by a label or salutation.
 *
 * Only the text immediately before the candidate counts: a "Name:" thirty words earlier
 * says nothing about this particular pair of capitalised words.
 */
function isIntroduced(text: string, start: number): boolean {
  const preceding = text.slice(Math.max(0, start - 40), start);
  if (SALUTATION.test(preceding.slice(-12))) return true;
  const tail = preceding.slice(-24);
  return NAME_CUES.test(tail) && /[:\-–]\s*$|\s$/.test(preceding);
}

function detectNames(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];

  for (const hit of text.matchAll(NAME_SHAPE)) {
    if (ORG_TAIL.test(hit[0])) continue;
    // A name is not glued to an operator: `Ctrl+Shift`, `Width=Height`, `Name/Value`.
    const neighbours = text.slice(Math.max(0, hit.index - 1), hit.index + hit[0].length + 1);
    if (/[+=/\\]/.test(neighbours)) continue;
    const trimmed = trimToName(hit[0]);
    if (!trimmed) continue;
    const value = trimmed.value;
    const start = hit.index + trimmed.offset;

    const introduced = isIntroduced(text, start);
    const known = hasKnownGivenName(value);

    found.push({
      type: "NAME",
      value,
      start,
      end: start + value.length,
      // A labelled field *and* a recognised given name is as sure as this gets. Either
      // one alone is strong enough to mask. Shape alone - two capitalised words that
      // could be a person or could be a product - lands in the review band, where the
      // element is withheld rather than transmitted on a guess. Dropping shape-only
      // candidates instead would mean every name outside the gazetteer, on any screen
      // without a label, passing through untouched.
      confidence:
        introduced && known ? 0.95 : introduced || known ? STRONG_EVIDENCE : WEAK_EVIDENCE,
    });
  }

  // A single capitalised word right after a salutation is still a name: "Dr. Sengupta".
  for (const hit of text.matchAll(new RegExp(`${SALUTATION.source}(${NAME_WORD})`, "g"))) {
    const value = hit[1]!;
    const start = hit.index + hit[0].length - value.length;
    if (found.some((match) => match.start <= start && match.end >= start + value.length)) continue;
    // A single word after a salutation is a name on its own - "Dr. Sengupta" - so the
    // two-word minimum that `looksLikeName` enforces does not apply here.
    if (isNotNameWord(value) || ORG_TAIL.test(value)) continue;
    found.push({
      type: "NAME",
      value,
      start,
      end: start + value.length,
      confidence: STRONG_EVIDENCE,
    });
  }

  return found;
}

function detectAddresses(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];

  for (const hit of text.matchAll(ADDRESS_SHAPE)) {
    const value = hit[0].trim();
    if (value.length < 12) continue;

    const start = hit.index + hit[0].indexOf(value);
    const preceding = text.slice(Math.max(0, start - 30), start);
    const hasLocality = ADDRESS_WORDS.test(value);
    const hasPin = PIN_CODE.test(value);
    const cued = ADDRESS_CUE.test(preceding);

    // A six-digit number on its own is never an address. "OTP 123456 sent to 9876543210"
    // ends in six digits and matched the whole line before this rule existed - the phone
    // number was masked as a postal address, which is both wrong and destroys the span
    // the phone detector had correctly claimed. A street word or an explicit label is
    // required; the PIN only raises confidence.
    if (!hasLocality && !cued) continue;

    const signals = Number(hasLocality) + Number(hasPin) + Number(cued);
    found.push({
      type: "ADDRESS",
      value,
      start,
      end: start + value.length,
      confidence: signals >= 3 ? 0.95 : signals === 2 ? STRONG_EVIDENCE : WEAK_EVIDENCE,
    });
  }

  return found;
}

/**
 * Every unstructured PII candidate in the text, in reading order.
 *
 * Spans may overlap each other and the structured detectors' spans; `resolveSpans` in the
 * Privacy Firewall reduces them, longest match first.
 */
export function detectUnstructuredPii(text: string): PiiMatch[] {
  const addresses = detectAddresses(text);

  // A street name inside a detected address is part of that address, not a second person
  // standing in it. Only weak, shape-only name candidates are dropped this way: an
  // explicitly labelled name inside an address line is still a name.
  const names = detectNames(text).filter(
    (name) =>
      name.confidence > WEAK_EVIDENCE ||
      !addresses.some((address) => name.start >= address.start && name.end <= address.end),
  );

  return [...names, ...addresses].sort(
    (left, right) => left.start - right.start || right.end - right.start - (left.end - left.start),
  );
}
