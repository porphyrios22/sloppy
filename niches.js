// Central registry of content niches. generateScript.js uses this to build
// its prompt; the dashboard uses it to populate the niche picker. Add a new
// niche by adding an entry here — nothing else needs to change.
//
// subjectNoun: what to call the "thing" the video is about, in UI copy
//   (e.g. "franchise" for anime, "case" for true crime, "topic" for facts).
// topicPool: rotates through these as the specific angle for a given subject,
//   same mechanism the original anime pool used.
// styleGuidance: appended to the prompt — tone, boundaries, what's in/out of
//   scope for this niche specifically.
// banRepeats: if true, recently-used subjects (within FRANCHISE_LOOKBACK
//   runs) are explicitly excluded from being picked again. Doesn't make
//   sense for niches without a repeatable "subject" (e.g. custom).

const NICHES = {
  "anime-superhero": {
    id: "anime-superhero",
    label: "Anime & Superhero Lore",
    subjectNoun: "franchise",
    focusNoun: "character focus",
    banRepeats: true,
    topicPool: [
      "a lesser-known origin story detail",
      "a power system explained simply",
      "a fan theory that turned out to be canon",
      "a hidden connection between two characters",
      "the darkest moment in a hero's backstory",
      "a rule of the universe most fans get wrong",
      "an underrated villain's motivation",
      "how a character's design changed over time",
      "a betrayal that changed the story forever",
      "the strongest character no one talks about",
    ],
    styleGuidance: `Pick a specific well-known anime or superhero franchise and character yourself.
Stay factually accurate to the source material. Don't invent plot points.`,
  },

  "movie-tv-trivia": {
    id: "movie-tv-trivia",
    label: "Movie & TV Trivia",
    subjectNoun: "movie or show",
    focusNoun: "specific detail",
    banRepeats: true,
    topicPool: [
      "a behind-the-scenes production fact",
      "a fan theory the creators later confirmed",
      "an alternate ending that almost happened",
      "a continuity detail almost nobody notices",
      "an actor who almost played a different role",
      "a scene that was almost cut",
      "a detail that only makes sense on a rewatch",
      "how a famous line was actually improvised",
      "a prop or costume with a hidden meaning",
      "a casting choice that changed the whole story",
    ],
    styleGuidance: `Pick a specific well-known movie or TV show yourself.
Stick to verifiable, publicly documented trivia — interviews, DVD commentaries,
production notes. Don't present rumors as confirmed fact; if something is
disputed, say so briefly rather than stating it flatly.`,
  },

  "science-space": {
    id: "science-space",
    label: "Science & Space Facts",
    subjectNoun: "topic",
    focusNoun: "specific phenomenon",
    banRepeats: true,
    topicPool: [
      "a mind-bending scale comparison",
      "a discovery that overturned earlier assumptions",
      "how something most people misunderstand actually works",
      "a real mission or experiment and what it found",
      "an open question scientists still can't fully answer",
      "a everyday phenomenon with a surprising explanation",
      "a record-breaking extreme in nature or space",
      "a historical scientific mistake and how it got corrected",
    ],
    styleGuidance: `Pick a specific science or space topic yourself (physics, biology,
astronomy, chemistry, earth science — vary it, don't default to the same
one every time).
Stick to well-established, mainstream science. Don't state contested or
fringe claims as settled fact, and don't give medical advice.`,
  },

  "space-facts-updates": {
    id: "space-facts-updates",
    label: "Space Facts & Updates",
    subjectNoun: "mission or object",
    focusNoun: "what's notable about it",
    banRepeats: true,
    topicPool: [
      "a current or recent space mission and its goal",
      "a striking fact about a planet, moon, or star",
      "how a piece of space tech actually works",
      "a discovery from a telescope or probe",
      "what would happen to a human body in a specific space scenario",
      "a comparison that makes an astronomical scale click",
      "an upcoming mission and what it's looking for",
    ],
    styleGuidance: `Pick a specific real space mission, celestial object, or piece of
space technology yourself. Favor NASA/ESA/other agency missions and
well-documented astronomical facts.
Don't state launch dates, mission outcomes, or "current" status as fact
unless you're confident it's accurate — hedge with general phrasing
("recently", "in coming years") rather than inventing specific dates.`,
  },

  "true-crime": {
    id: "true-crime",
    label: "True Crime / Mystery",
    subjectNoun: "case",
    focusNoun: "person involved",
    banRepeats: true,
    styleGuidance: `Pick a specific, well-documented, publicly reported case yourself
(the kind that's been covered in mainstream journalism, documentaries, or
official records — not speculation about private individuals who aren't
public figures in this context).
Be factual and restrained — no invented dialogue, no glorifying the
perpetrator, no gratuitous detail about violence. Focus on what happened,
the investigation, and the outcome or open questions. If the case is
unsolved, say so rather than implying a resolution that didn't happen.`,
    topicPool: [
      "a detail from the case that still puzzles investigators",
      "how the case was ultimately solved (or why it wasn't)",
      "a piece of evidence that changed the investigation's direction",
      "a theory investigators pursued and ruled out",
      "the moment the case broke open",
      "a detail the public got wrong about the case",
      "how forensic advances later reopened the case",
    ],
  },

  "horror-stories": {
    id: "horror-stories",
    label: "Horror Stories",
    subjectNoun: "story",
    focusNoun: "central character",
    banRepeats: false,
    styleGuidance: `Write an original short horror narration — fiction, not a real event
and not attributed to any real person or place. Build dread through
implication and pacing rather than graphic gore. End on an unsettling
note, not a jump-scare description (this is audio-only, no visual scare
timing to work with).
Clearly this is fiction — don't frame it as a "true story" or attach it
to real named locations/people.`,
    topicPool: [
      "something in the house that shouldn't be there",
      "a routine trip that goes somewhere it shouldn't",
      "a phone call that shouldn't have been possible",
      "a neighbor who is very slightly wrong",
      "a rule that must never be broken, and why",
      "a place that doesn't appear on any map",
      "someone who realizes too late what they agreed to",
    ],
  },

  "mind-twist-trivia": {
    id: "mind-twist-trivia",
    label: "Mind-Twist Trivia",
    subjectNoun: "topic",
    focusNoun: "the twist",
    banRepeats: false,
    styleGuidance: `Structure this as a setup-then-reveal: state a fact or scenario that
sounds like it means one thing, then reveal the counterintuitive truth
partway through. The "twist" should land clearly — don't bury it. Keep
every claim factually accurate; the surprise should come from framing,
not from exaggeration or invented numbers.`,
    topicPool: [
      "a statistic that means the opposite of what it sounds like",
      "two things that seem unrelated but are actually connected",
      "something that sounds fake but is completely real",
      "a common belief that's backwards",
      "a coincidence that has a logical explanation",
      "a rule with a loophole nobody expects",
      "a number that's wildly different from what people guess",
    ],
  },

  custom: {
    id: "custom",
    label: "Custom niche",
    subjectNoun: "subject",
    focusNoun: "focus",
    banRepeats: false,
    isCustom: true,
    // No topicPool/styleGuidance — buildPrompt() substitutes the user's
    // free-text description in generateScript.js instead.
  },
};

const NICHE_LIST = Object.values(NICHES).map(({ id, label, isCustom }) => ({ id, label, isCustom: !!isCustom }));

function getNiche(id) {
  return NICHES[id] || NICHES["anime-superhero"];
}

module.exports = { NICHES, NICHE_LIST, getNiche };