export type TeachingConcept = {
  id: string;
  title: string;
  definition: string;
  prerequisites: string[];
  outcome: string;
  criteria: string[];
  exercisePatterns: string[];
};

export type TeachingPreset = {
  id: string;
  title: string;
  description: string;
  concepts: TeachingConcept[];
  domainRules: string[];
};

const concepts: TeachingConcept[] = [
  {
    id: "eq_controls",
    title: "Frequency, Gain, and Q",
    definition: "Understand where an EQ move acts, how much level changes, and how wide the affected band is.",
    prerequisites: [],
    outcome: "Predict the audible role of Frequency, Gain, and Q before touching the plugin.",
    criteria: [
      "Separates frequency location from gain amount.",
      "Explains narrow versus broad Q as different intervention scopes.",
      "Does not treat analyzer peaks as automatic errors."
    ],
    exercisePatterns: [
      "Predict three EQ moves before listening.",
      "Choose broad or narrow Q for a tonal-shaping versus corrective case."
    ]
  },
  {
    id: "source_before_eq",
    title: "Source and Arrangement Before EQ",
    definition: "Check source choice, orchestration, register, articulation, level, panning, and depth before using EQ.",
    prerequisites: ["eq_controls"],
    outcome: "Reject unnecessary EQ when another production decision is the real cause.",
    criteria: [
      "Checks musical role before spectral surgery.",
      "Separates level problems from tonal problems.",
      "Can propose a non-EQ fix for a masking-like complaint."
    ],
    exercisePatterns: [
      "Classify complaints as source, arrangement, level, spatial, or EQ problems.",
      "Given a crowded cue, decide what should be fixed before EQ."
    ]
  },
  {
    id: "low_end_hpf",
    title: "Low-End Role and High-Pass Decisions",
    definition: "Decide whether low-frequency content is musical information, useful body, or unwanted energy in the current arrangement.",
    prerequisites: ["source_before_eq"],
    outcome: "Choose whether to high-pass from role and lowest useful information, without fixed-frequency recipes.",
    criteria: [
      "Does not apply one cutoff to every instrument.",
      "Checks note range and orchestral role before filtering.",
      "Explains why cello, horn, or piano may legitimately need content below 250 Hz."
    ],
    exercisePatterns: [
      "Decide whether four orchestral parts should be high-passed and justify each choice.",
      "Find the highest safe cutoff in context and explain what changed."
    ]
  },
  {
    id: "tonal_balance",
    title: "Tonal Balance",
    definition: "Use broad spectral moves to change overall character without confusing normal timbre with defects.",
    prerequisites: ["eq_controls", "source_before_eq"],
    outcome: "Separate broad tonal shaping from narrow corrective EQ.",
    criteria: [
      "Uses broad moves for broad problems.",
      "Describes dark, bright, thin, and heavy without immediately naming a fixed frequency.",
      "Checks the result in the full mix."
    ],
    exercisePatterns: [
      "Choose broad shelf, broad bell, or no EQ for three tonal complaints.",
      "Describe the tonal goal first, then find the minimum spectral move."
    ]
  },
  {
    id: "resonance",
    title: "Resonance Versus Normal Spectral Peak",
    definition: "Identify an audible resonant problem without assuming that a visible peak is wrong.",
    prerequisites: ["tonal_balance"],
    outcome: "Confirm a resonance by listening and controlled A/B before cutting it.",
    criteria: [
      "Starts from an audible symptom, not a graph peak.",
      "Uses sweep only as a locator and returns to realistic gain for judgment.",
      "Explains why harmonics and formants may legitimately appear as peaks."
    ],
    exercisePatterns: [
      "Classify candidate peaks as likely resonance, normal structure, or insufficient evidence.",
      "Locate a harsh frequency, reset the boost, then verify the cut in context."
    ]
  },
  {
    id: "masking",
    title: "Frequency Masking",
    definition: "Treat masking as a relationship between simultaneous sources, not a defect inside one spectrum.",
    prerequisites: ["source_before_eq", "tonal_balance"],
    outcome: "Diagnose competition between sources and choose the least destructive remedy.",
    criteria: [
      "Checks the sources together and separately.",
      "Considers arrangement, level, panning, and role before complementary EQ.",
      "Chooses which source should yield from foreground/background priority."
    ],
    exercisePatterns: [
      "Predict which of two parts should yield spectral space and explain why.",
      "Compare arrangement, level, and EQ fixes for one masking case."
    ]
  },
  {
    id: "context_ab",
    title: "Context and Level-Matched A/B",
    definition: "Use solo for diagnosis while making the final decision in the mix with loudness bias controlled.",
    prerequisites: ["tonal_balance", "masking"],
    outcome: "Make EQ decisions that survive full-mix, level-matched bypass comparison.",
    criteria: [
      "Uses solo as evidence gathering rather than the final verdict.",
      "Controls louder-is-better bias.",
      "Can reverse a solo-perfect move when it harms the mix."
    ],
    exercisePatterns: [
      "Perform a level-matched bypass A/B and report what remains improved.",
      "Compare the same EQ decision in solo and full mix."
    ]
  },
  {
    id: "presence_depth",
    title: "Presence, Brightness, and Depth",
    definition: "Distinguish presence from brightness and combine EQ with level and spatial cues for FG/MG/BG placement.",
    prerequisites: ["context_ab"],
    outcome: "Change perceptual depth without treating high-frequency reduction as a complete depth model.",
    criteria: [
      "Separates presence from air or sparkle.",
      "Uses level and direct-to-room balance alongside EQ.",
      "Avoids fixed frequency prescriptions for depth."
    ],
    exercisePatterns: [
      "Move a part from foreground to midground using the smallest set of changes.",
      "Identify whether a requested change is presence, brightness, or depth."
    ]
  },
  {
    id: "eq_vs_harmonics",
    title: "EQ Versus Saturation and Layering",
    definition: "Decide whether the goal is to rebalance existing energy or create new harmonic content.",
    prerequisites: ["tonal_balance", "context_ab"],
    outcome: "Choose EQ, saturation, or layering according to the perceptual goal.",
    criteria: [
      "Knows EQ redistributes existing energy while saturation can create harmonics.",
      "Checks whether added harmonics create new masking.",
      "Uses layering as composition or sound design when the source lacks desired information."
    ],
    exercisePatterns: [
      "Choose EQ or saturation for three brightness/presence requests.",
      "Design a thin layer that adds texture without duplicating low mids."
    ]
  },
  {
    id: "orchestration_transfer",
    title: "Transfer to Orchestration and Game Music",
    definition: "Apply EQ reasoning to unfamiliar orchestral and game-music situations without copying EDM recipes.",
    prerequisites: ["low_end_hpf", "resonance", "masking", "presence_depth", "eq_vs_harmonics"],
    outcome: "Solve an unseen orchestral mix problem using musical role, acoustics, and spectral evidence.",
    criteria: [
      "Explains the orchestration decision before the plugin move.",
      "Preserves legitimate instrument body and timbre.",
      "Transfers the reasoning to an unseen instrument or cue."
    ],
    exercisePatterns: [
      "Diagnose a new strings/brass/woodwinds masking problem without a frequency cheat sheet.",
      "Explain why an EDM HPF recipe fails on a specific orchestral passage."
    ]
  }
];

export const TEACHING_PRESETS: Record<string, TeachingPreset> = {
  "mixing.eq.core.v1": {
    id: "mixing.eq.core.v1",
    title: "EQ for Mixing, Orchestration, and Game Music",
    description: "Practice-first EQ learning that separates tonal balance, resonance, masking, depth, source decisions, and transfer.",
    concepts,
    domainRules: [
      "Do not prescribe fixed cutoff or boost frequencies without source and musical-role context.",
      "Analyzer peaks are evidence, not verdicts.",
      "Prefer source, arrangement, register, articulation, level, and spatial fixes before unnecessary EQ.",
      "Use solo for diagnosis and the full mix for the final judgment.",
      "Reduce loudness bias with level-matched A/B when practical.",
      "Require transfer to an unseen source before calling a concept mastered."
    ]
  }
};

export function getTeachingPreset(id: string): TeachingPreset {
  const preset = TEACHING_PRESETS[id];
  if (!preset) throw new Error("UNKNOWN_TEACHING_PRESET");
  return preset;
}
