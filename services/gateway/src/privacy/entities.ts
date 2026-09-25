/**
 * What the gateway looks for, and how each kind of entity is treated (spec
 * section 5). Presidio supplies the built-in recognizers; MEDICAL_RECORD,
 * US_NPI and HEALTH_TERM come from the ad-hoc recognizers below, which are
 * sent with every /analyze request.
 */

/** One detected entity. Offsets are UTF-16 indices into the analysed text. */
export type Detected = { type: string; start: number; end: number; score: number };

/** Replaced with <TYPE_N> and restored in answers. */
export const PERSONAL_ENTITIES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "IN_AADHAAR",
  "IN_PAN",
  "US_SSN",
  "IP_ADDRESS",
  "IBAN_CODE",
  "US_PASSPORT",
  "US_DRIVER_LICENSE",
  "CRYPTO",
] as const;
/** Replaced with [CARD REMOVED] and never restored. Presidio checks the Luhn digit. */
export const CARD_ENTITIES = ["CREDIT_CARD"] as const;
/** Replaced with <TYPE_N>; any one of them makes the text PHI. */
export const MEDICAL_ID_ENTITIES = ["MEDICAL_LICENSE", "MEDICAL_RECORD", "US_NPI"] as const;
/** Conditions, drugs and procedures: left in place (the model needs them) and used only to classify. */
export const HEALTH_TERM = "HEALTH_TERM";

/** Entity types requested from Presidio. LOCATION, DATE_TIME, NRP and URL are left out on purpose. */
export const DETECTED_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, ...MEDICAL_ID_ENTITIES, HEALTH_TERM];

/** Built-in Presidio entities the gateway refuses to run without (checked at start-up, V4). */
export const REQUIRED_PRESIDIO_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, "MEDICAL_LICENSE"];

const PERSONAL = new Set<string>(PERSONAL_ENTITIES);
const MEDICAL_ID = new Set<string>(MEDICAL_ID_ENTITIES);

export const isPersonal = (type: string): boolean => PERSONAL.has(type);
export const isCard = (type: string): boolean => type === "CREDIT_CARD";
export const isMedicalId = (type: string): boolean => MEDICAL_ID.has(type);
export const isHealthTerm = (type: string): boolean => type === HEALTH_TERM;
/** Types that become numbered placeholders. */
export const isMasked = (type: string): boolean => PERSONAL.has(type) || MEDICAL_ID.has(type);

/**
 * ChainAim's health-term list, matched as whole words in any case. Ambiguous
 * abbreviations (AIDS, STD, STI) are left out: "std::vector" in a coding
 * question must not make a request PHI.
 */
export const HEALTH_TERMS: readonly string[] = [
  // conditions
  "diabetes", "diabetic", "hypertension", "high blood pressure", "asthma", "cancer", "tumor", "tumour",
  "leukemia", "lymphoma", "HIV", "hepatitis", "tuberculosis", "pneumonia", "COVID-19", "depression",
  "anxiety disorder", "bipolar disorder", "schizophrenia", "PTSD", "ADHD", "autism", "dementia",
  "Alzheimer's", "Parkinson's", "epilepsy", "seizure", "stroke", "heart attack", "heart failure",
  "arrhythmia", "chest pain", "migraine", "arthritis", "lupus", "multiple sclerosis", "kidney disease",
  "cirrhosis", "obesity", "pregnant", "pregnancy", "miscarriage", "infertility", "overdose", "addiction",
  "opioid use disorder", "eating disorder", "anorexia", "chlamydia", "syphilis", "herpes",
  // drugs
  "insulin", "metformin", "lisinopril", "atorvastatin", "amlodipine", "sertraline", "fluoxetine",
  "prozac", "xanax", "adderall", "oxycodone", "methadone", "buprenorphine", "warfarin", "prednisone",
  // procedures and care
  "chemotherapy", "radiotherapy", "dialysis", "biopsy", "mastectomy", "transplant", "surgery",
  "inhaler", "diagnosed", "diagnosis", "prescribed", "prescription",
];

export type AdHocRecognizer = {
  name: string;
  supported_language: "en";
  supported_entity: string;
  patterns?: { name: string; regex: string; score: number }[];
  context?: string[];
  deny_list?: readonly string[];
};

/**
 * Sent with every /analyze call. A pattern scored 0.1 passes the 0.4
 * threshold only when Presidio finds a context word near it (+0.35, floor
 * 0.4), which is how "needs a context word" is expressed.
 */
export const AD_HOC_RECOGNIZERS: readonly AdHocRecognizer[] = [
  {
    name: "ChainAim medical record number",
    supported_language: "en",
    supported_entity: "MEDICAL_RECORD",
    patterns: [{ name: "mrn (needs context)", regex: "\\b[A-Z]{0,3}\\d{6,10}\\b", score: 0.1 }],
    context: ["mrn", "medical", "record"],
  },
  {
    name: "ChainAim NPI",
    supported_language: "en",
    supported_entity: "US_NPI",
    patterns: [{ name: "npi (needs context)", regex: "\\b[12]\\d{9}\\b", score: 0.1 }],
    context: ["npi"],
  },
  { name: "ChainAim health terms", supported_language: "en", supported_entity: HEALTH_TERM, deny_list: HEALTH_TERMS },
];
