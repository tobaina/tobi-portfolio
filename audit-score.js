/* ==========================================================================
   Workflow Audit — the questions, and the arithmetic behind the number.

   ⚠️  THE HOURS FIGURE IS ARITHMETIC ON THE VISITOR'S OWN ANSWERS, AND IT
   MUST STAY THAT WAY. It is not a score, a band, or an impression dressed up
   as a number. Every hour shown traces back to something they told us, and
   the result page prints the working. The moment this starts estimating on
   their behalf, the whole page becomes a guess with a decimal point on it,
   and the first client who checks it stops trusting everything else we say.

   ⚠️  THE CAP IS THE HONESTY GUARD AND IT IS NOT OPTIONAL.
   Recoverable time cannot exceed the time they say they spend on admin at
   all. Somebody who reports "under 2 hours a week of admin" while their
   intake answers multiply out to 14 is telling us one of the two answers is
   wrong, and the honest move is to show the smaller one and say why. A lead
   magnet that inflates its own number is the exact thing this business says
   it is not.

   ⚠️  IT MUST BE ABLE TO SAY "DO NOT BUILD ANYTHING YET".
   The contact section already promises we will say so when the answer is no.
   If this tool cannot reach that conclusion, that promise is decoration. The
   `notYet` verdict is a feature, not an edge case to tune away.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PolishaAudit = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Each option carries the number it contributes, so the arithmetic lives
     beside the words the visitor actually read rather than in a lookup table
     somewhere else that can drift away from them. */
  var QUESTIONS = [
    {
      id: "volume",
      section: "Your process",
      text: "How many new enquiries or jobs do you handle in a typical week?",
      options: [
        { value: "v0", label: "Up to 5", n: 3 },
        { value: "v1", label: "6 to 20", n: 13 },
        { value: "v2", label: "21 to 50", n: 35 },
        { value: "v3", label: "More than 50", n: 70 },
      ],
    },
    {
      id: "channels",
      section: "Your process",
      text: "Where do they arrive?",
      hint: "Choose every one that applies.",
      multi: true,
      options: [
        { value: "email", label: "Email" },
        { value: "phone", label: "Phone" },
        { value: "chat", label: "WhatsApp or social messages" },
        { value: "form", label: "A form on your website" },
        { value: "inperson", label: "In person" },
        { value: "booking", label: "A booking or marketplace site" },
        { value: "other", label: "Somewhere else" },
      ],
    },
    {
      id: "manual",
      section: "Your process",
      text: "How much of getting one of them into your system is typed in by hand?",
      options: [
        { value: "all", label: "All of it", n: 1 },
        { value: "most", label: "Most of it", n: 0.7 },
        { value: "some", label: "Some of it", n: 0.35 },
        { value: "none", label: "None, it arrives ready", n: 0 },
      ],
    },
    {
      id: "minutes",
      section: "Your process",
      text: "How long does it take to get one fully logged and assigned?",
      options: [
        { value: "m5", label: "Under 5 minutes", n: 4 },
        { value: "m15", label: "5 to 15 minutes", n: 10 },
        { value: "m30", label: "15 to 30 minutes", n: 22 },
        { value: "m30plus", label: "More than 30 minutes", n: 40 },
      ],
    },
    {
      id: "duplication",
      section: "Where time goes",
      text: "How often do you type the same information into a second place?",
      options: [
        { value: "never", label: "Never", n: 0 },
        { value: "few", label: "A few times a week", n: 0.5 },
        { value: "many", label: "Several times a day", n: 1.5 },
        { value: "constant", label: "Constantly", n: 3 },
      ],
    },
    {
      id: "tracking",
      section: "Where time goes",
      text: "How do you know what stage each job is at?",
      options: [
        { value: "system", label: "A system built for it", n: 0 },
        { value: "spreadsheet", label: "A spreadsheet", n: 0 },
        { value: "docs", label: "Shared documents or a chat thread", n: 0 },
        { value: "memory", label: "Mostly memory and notes", n: 0 },
      ],
    },
    {
      id: "chasing",
      section: "Communication",
      text: "How much of your week goes on answering “where is my…”?",
      options: [
        { value: "none", label: "Barely any", n: 0 },
        { value: "under1", label: "Under an hour", n: 0.5 },
        { value: "one3", label: "One to three hours", n: 2 },
        { value: "three", label: "More than three hours", n: 4 },
      ],
    },
    {
      id: "reminders",
      section: "Communication",
      text: "Which of these do you send by hand?",
      hint: "Choose every one that applies.",
      multi: true,
      perItemHours: 0.5,
      options: [
        { value: "appointments", label: "Appointment or booking reminders" },
        { value: "payment", label: "Payment chasers" },
        { value: "status", label: "Progress updates" },
        { value: "docs", label: "Requests for documents or information" },
        { value: "reviews", label: "Review or feedback requests" },
        /* ⚠️  WITHOUT THIS, SOMEBODY WHO SENDS NO REMINDERS BY HAND CANNOT
           GET PAST THIS QUESTION. A multi-choice question with no "none"
           option is a dead end for exactly the people whose honest answer is
           nothing, and those are the ones the audit most needs to be able to
           tell that no system is worth building. `exclusive` clears the
           others when it is picked. */
        { value: "none", label: "None of these", exclusive: true },
      ],
    },
    {
      id: "misses",
      section: "Where time goes",
      text: "How often does something get missed, forgotten or done twice?",
      options: [
        { value: "never", label: "Almost never", n: 0 },
        { value: "monthly", label: "About monthly", n: 0 },
        { value: "weekly", label: "About weekly", n: 0 },
        { value: "daily", label: "Several times a week", n: 0 },
      ],
    },
    {
      /* ⚠️  THIS ANSWER IS THE CEILING ON EVERY OTHER ANSWER. See the cap. */
      id: "admin",
      section: "Where time goes",
      text: "Across the whole team, how much of a normal week goes on admin rather than the actual work?",
      options: [
        { value: "a2", label: "Under 2 hours", n: 2 },
        { value: "a5", label: "2 to 5 hours", n: 5 },
        { value: "a10", label: "5 to 10 hours", n: 10 },
        { value: "a10plus", label: "More than 10 hours", n: 16 },
      ],
    },
    {
      /* ⚠️  THIS QUESTION REPLACED ONE ASKING WHAT SHOULD "STAY HUMAN".
         That framing only makes sense if something non-human is otherwise
         doing the work, which is a claim this business has decided not to
         make anywhere. The slot was kept rather than dropped, because twelve
         questions is what the page promises, and this one earns its place:
         head count is the single biggest driver of what a build costs, and
         knowing it before the first call saves a round trip. */
      id: "team",
      section: "Your team",
      text: "How many people would use it day to day?",
      options: [
        { value: "t1", label: "Just me", n: 0 },
        { value: "t5", label: "2 to 5", n: 0 },
        { value: "t20", label: "6 to 20", n: 0 },
        { value: "t21", label: "More than 20", n: 0 },
      ],
    },
    {
      id: "priority",
      section: "What matters",
      text: "If one of these were fixed tomorrow, which would make the biggest difference?",
      options: [
        { value: "intake", label: "Getting work in and assigned without typing", n: 0 },
        { value: "visibility", label: "Knowing where everything stands", n: 0 },
        { value: "chasing", label: "Not being chased for updates", n: 0 },
        { value: "followup", label: "Nothing slipping through the cracks", n: 0 },
        { value: "reporting", label: "Seeing what is actually happening in the numbers", n: 0 },
      ],
    },
  ];

  function byId(id) {
    for (var i = 0; i < QUESTIONS.length; i++) if (QUESTIONS[i].id === id) return QUESTIONS[i];
    return null;
  }

  /* An unanswered or unrecognised value contributes nothing, never NaN and
     never a default that invents an answer on the visitor's behalf. */
  function n(id, value) {
    var q = byId(id);
    if (!q || !q.options) return 0;
    for (var i = 0; i < q.options.length; i++) {
      if (q.options[i].value === value) return typeof q.options[i].n === "number" ? q.options[i].n : 0;
    }
    return 0;
  }

  /* "None of these" is an answer, not a thing chosen. Counting it would
     charge somebody half an hour a week for the reminders they told us they
     do not send. */
  function real(list) {
    return list.filter(function (v) { return v !== "none"; });
  }

  function chosen(answers, id) {
    var v = answers ? answers[id] : null;
    if (!v) return [];
    var list = Array.isArray(v) ? v : [v];
    var q = byId(id);
    if (!q || !q.options) return [];
    return list.filter(function (x) {
      return q.options.some(function (o) { return o.value === x; });
    });
  }

  function labelFor(id, value) {
    var q = byId(id);
    if (!q) return "";
    for (var i = 0; i < q.options.length; i++) if (q.options[i].value === value) return q.options[i].label;
    return "";
  }

  function round(h) { return Math.round(h * 2) / 2; }

  function score(answers) {
    answers = answers || {};

    var volume = n("volume", answers.volume);
    var minutes = n("minutes", answers.minutes);
    var manual = n("manual", answers.manual);

    /* Four components, each traceable to the questions that produced it. */
    var parts = [
      {
        key: "intake",
        label: "Getting work in and assigned",
        hours: (volume * minutes * manual) / 60,
        working:
          volume + " a week × " + minutes + " minutes × " +
          Math.round(manual * 100) + "% done by hand",
        fix: "Automatic intake and assignment",
      },
      {
        key: "duplication",
        label: "Typing the same thing twice",
        hours: n("duplication", answers.duplication),
        working: labelFor("duplication", answers.duplication) || "Not answered",
        fix: "One record everything reads from",
      },
      {
        key: "chasing",
        label: "Answering “where is my…”",
        hours: n("chasing", answers.chasing),
        working: labelFor("chasing", answers.chasing) || "Not answered",
        fix: "A client portal that answers it for you",
      },
      {
        key: "reminders",
        label: "Sending reminders and follow ups by hand",
        hours: real(chosen(answers, "reminders")).length * byId("reminders").perItemHours,
        working: real(chosen(answers, "reminders")).length + " kind(s), about 30 minutes each a week",
        fix: "Reminders and follow ups that send themselves",
      },
    ];

    var raw = parts.reduce(function (t, p) { return t + p.hours; }, 0);
    var cap = n("admin", answers.admin);

    /* ⚠️  THE CAP. Do not remove it to make the headline number bigger. */
    var capped = cap > 0 && raw > cap;
    var hours = capped ? cap : raw;

    /* Ranked by what each one actually costs them, so the first thing we
       suggest is the first thing worth doing, not the first thing we like
       building. Zero-hour components are not offered as opportunities. */
    var opportunities = parts
      .filter(function (p) { return p.hours > 0; })
      .sort(function (a, b) { return b.hours - a.hours; })
      .slice(0, 3);

    var stalls = [];
    if (real(chosen(answers, "channels")).length >= 3) {
      stalls.push("Work arrives through " + real(chosen(answers, "channels")).length +
        " different channels, so nothing has one queue.");
    }
    if (answers.tracking === "memory") {
      stalls.push("Stage is tracked in memory and notes, which is the hardest thing to hand over or cover for.");
    } else if (answers.tracking === "docs") {
      stalls.push("Stage lives in documents and chat threads, so the answer depends on who you ask.");
    } else if (answers.tracking === "spreadsheet") {
      stalls.push("A spreadsheet holds the truth, which works until two people open it.");
    }
    if (answers.misses === "daily" || answers.misses === "weekly") {
      stalls.push("Things are being missed or repeated " +
        (answers.misses === "daily" ? "several times a week" : "about weekly") +
        ", which usually means the process depends on somebody remembering.");
    }


    /* ⚠️  "NOT YET" IS A REAL ANSWER AND MUST SURVIVE.
       Under three hours a week, a build cannot pay for itself at our prices,
       and saying so is the whole reason anyone should believe the rest. */
    var verdict;
    if (hours < 3) {
      verdict = {
        key: "notYet",
        headline: "We would not build you a system yet.",
        body: "On your own answers there is not enough repeated work here to pay for a build at our prices. " +
          "Tidying what you already use will get you further this year than new software would. " +
          "If the volume changes, come back.",
        cta: "none",
      };
    } else if (hours < 6) {
      verdict = {
        key: "worthATalk",
        headline: "There is something here, but it is one problem rather than a system.",
        body: "That is usually worth a short conversation and a small fix rather than a build. " +
          "The diagnostic covers exactly this, and it costs nothing.",
        /* ⚠️  BOTH VERDICTS POINT AT THE SAME FREE DIAGNOSTIC NOW.
           There used to be two human first steps, a free process check and a
           paid diagnostic, and this verdict sent people to the cheaper one.
           The diagnostic is free while we take on our first clients, so the
           two collapsed into one and sending anyone to a second, lesser
           offer would just be a worse version of the same conversation. */
        cta: "diagnostic",
      };
    } else {
      verdict = {
        key: "worthBuilding",
        headline: "There is enough here to be worth building for.",
        body: "At this much repeated work a system pays for itself, and the next step is to confirm these " +
          "numbers against what actually happens rather than against a questionnaire.",
        cta: "diagnostic",
      };
    }

    return {
      hours: round(hours),
      rawHours: round(raw),
      cappedByOwnEstimate: capped,
      capHours: cap,
      parts: parts.map(function (p) { return { key: p.key, label: p.label, hours: round(p.hours), working: p.working, fix: p.fix }; }),
      opportunities: opportunities.map(function (p) { return { key: p.key, fix: p.fix, hours: round(p.hours), because: p.label.toLowerCase() }; }),
      stalls: stalls,
      team: labelFor("team", answers.team),
      priority: labelFor("priority", answers.priority),
      verdict: verdict,
      answered: QUESTIONS.filter(function (q) {
        var a = answers[q.id];
        return q.multi ? Array.isArray(a) && a.length > 0 : !!a;
      }).length,
      total: QUESTIONS.length,
    };
  }

  return { QUESTIONS: QUESTIONS, score: score, labelFor: labelFor };
});
