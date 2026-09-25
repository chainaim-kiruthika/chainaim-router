/**
 * SYNTHETIC privacy corpus. Every name, number and address below is
 * invented. The stub Presidio (scripts/stub-presidio.ts) "detects" exactly
 * these values, so tests can prove that none of them ever reaches a model,
 * Jev or the ledger. Never add real data here.
 */
export type KnownValue = { value: string; type: string };

export const KNOWN_VALUES: readonly KnownValue[] = [
  { value: "Jane Roe", type: "PERSON" },
  { value: 'Jane "JR" Roe', type: "PERSON" },
  { value: "Arjun Mehta", type: "PERSON" },
  { value: "Priya Sharma", type: "PERSON" },
  { value: "Tom Baker", type: "PERSON" },
  { value: "Alan Grant", type: "PERSON" },
  { value: "Maria Garcia", type: "PERSON" },
  { value: "jane.roe@example.com", type: "EMAIL_ADDRESS" },
  { value: "+1 415 555 0132", type: "PHONE_NUMBER" },
  { value: "2345 6789 0123", type: "IN_AADHAAR" },
  { value: "ABCPE1234F", type: "IN_PAN" },
  { value: "078-05-1120", type: "US_SSN" },
  { value: "912803456", type: "US_PASSPORT" },
  { value: "D1234567", type: "US_DRIVER_LICENSE" },
  { value: "192.168.10.45", type: "IP_ADDRESS" },
  { value: "DE89370400440532013000", type: "IBAN_CODE" },
  { value: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", type: "CRYPTO" },
  { value: "4111 1111 1111 1111", type: "CREDIT_CARD" },
  { value: "5500005555555559", type: "CREDIT_CARD" },
  { value: "AB1234563", type: "MEDICAL_LICENSE" },
  { value: "991122", type: "MEDICAL_RECORD" },
  { value: "1234567893", type: "US_NPI" },
];

export type CorpusItem = { id: string; text: string; expect: { dataClass: string; found: string[] } };

export const CORPUS: readonly CorpusItem[] = [
  { id: "phi-mrn", text: "Patient Jane Roe, MRN 991122, was diagnosed with diabetes last spring.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  { id: "pii-contact", text: "Email jane.roe@example.com or call +1 415 555 0132 about invoice 7781.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "pci-card", text: "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta.", expect: { dataClass: "PCI", found: ["PCI", "PII"] } },
  { id: "pii-india", text: "Aadhaar 2345 6789 0123 and PAN ABCPE1234F belong to Priya Sharma.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "pii-us", text: "SSN 078-05-1120 for Tom Baker; passport 912803456; licence D1234567.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "phi-npi", text: "Dr. Alan Grant (NPI 1234567893, DEA AB1234563) prescribed metformin.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  {
    id: "pii-network",
    text: "Wire from IBAN DE89370400440532013000, login from 192.168.10.45, refund to 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.",
    expect: { dataClass: "PII", found: ["PII"] },
  },
  { id: "none-health", text: "What are the common early symptoms of asthma?", expect: { dataClass: "none", found: [] } },
  { id: "none-plain", text: "Summarize the plot of Hamlet in two sentences.", expect: { dataClass: "none", found: [] } },
  { id: "pii-repeat", text: "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "phi-emoji", text: "🙂 Thanks, Jane Roe! Your asthma inhaler refill is ready.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  { id: "pci-only", text: "Refund card 5500005555555559 please.", expect: { dataClass: "PCI", found: ["PCI"] } },
  { id: "phi-quoted", text: 'Ship to Jane "JR" Roe, file C:\\records\\991122.txt.', expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
];
