import "../isolate.js"; // first
import assert from "node:assert/strict";
import { privacyReason, type PrivateWords } from "../../src/web/privacy.js";

// Made-up private details: a person, two notes of his own, and one long file.
const file = "The supplier will deliver seven green folders arranged by room to the upper landing before the second inspection on the agreed morning.";
const known: PrivateWords = { names: ["Lena Marsh", "Lena", "Marsh"], own: 2,
  texts: ["Lena prefers the blue folders kept beside the east window at all times.", "Remember the spare key is under the third pot.", file] };

// Ordinary public questions pass, including ones that used to be mistaken for something private.
for (const fine of [
  "public museum opening dates",
  "small business safety rebate 2025 2026 conditions",
  "AS 1428.1-2009 clear opening width for doorways",
  "2026 changes to court filing rules",
  "top 10 documentaries on the way people learn",
  "seven green folders",                               // three ordinary words that happen to be in a file
  "how to arrange folders by room",
  "12 best ways to place a shelf",
]) assert.equal(privacyReason(fine, known), null, fine);

// Private details are refused, each with a reason the bot can act on.
assert.match(privacyReason("Lena Marsh public information", known)!, /private name/);
assert.match(privacyReason("someone at example dot com", known)!, /email/);
assert.match(privacyReason("who owns person@example.com", known)!, /email/);
for (const phone of ["call 0412 345 678 about quotes", "+61 412 345 678 reviews", "(02) 9876 5432 opening hours", "0298765432"])
  assert.match(privacyReason(phone, known)!, /phone/, phone);
for (const street of ["12 Example Road rebuild cost", "builders near 4a Example St", "7 Example Court planning rules", "3 Example Drive sale history"])
  assert.match(privacyReason(street, known)!, /street/, street);
// His own notes: five words in a row are enough. A file needs a longer run.
assert.match(privacyReason("why keep blue folders kept beside the east window", known)!, /private notes or file text/);
assert.match(privacyReason("deliver seven green folders arranged by room to the upper landing", known)!, /private notes or file text/);
assert.equal(privacyReason("seven green folders arranged by room", known), null, "a short run from a file is ordinary words");

// A web address is checked for names and contact details, not for wording.
assert.equal(privacyReason("https://www.example.org/seven-green-folders-arranged-by-room-to-the-upper-landing-before", known, "address"), null);
assert.match(privacyReason("https://www.example.org/people/lena-marsh", known, "address")!, /private name/);
assert.equal(privacyReason("https://www.example.org/news/2026/11/20/article-48213", known, "address"), null);
console.log("web-privacy: private details are refused; ordinary public questions and addresses pass");
