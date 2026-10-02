/* ==========================================================================
   The name on every email this site sends.

   ⚠️  THE DISPLAY NAME IS NOT CONFIGURATION, AND THAT IS THE POINT.
   EMAIL_FROM was set to "Tobi Aina <hello@getpolisha.com>", so every
   confirmation a visitor received was signed with a personal name. The site
   itself had every trace of an individual removed from it over several
   passes, and this survived all of them because it lived in an environment
   variable instead of in the repository, where nobody reads it and nothing
   tests it.

   A sender name is brand copy. It belongs here, under test, beside the rest
   of the copy it has to agree with. The address stays in the environment,
   because that is deployment configuration and it genuinely varies. The name
   does not vary, so it is no longer able to drift.
   ========================================================================== */

/* Accepts either "Name <address>" or a bare "address" and always returns the
   company name in front of whatever address is configured. */
function senderFrom(raw) {
  if (!raw) { return raw; }
  const text = String(raw).trim();
  const angled = text.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : text).trim();
  if (!address) { return raw; }
  return "Polisha Systems <" + address + ">";
}

module.exports = { senderFrom };
