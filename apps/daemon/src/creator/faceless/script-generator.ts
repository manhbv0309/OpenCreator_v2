import type { CreatorServicesConfigStore } from '../../creator-services/config-store.js';
import {
  fetchCreatorService,
  openAiCompatibleEndpoint
} from '../../creator-services/upstream-fetch.js';

export type GenerateScriptInput = {
  topic: string;
  targetDurationMinutes?: number;
  tone?: string;
  configStore?: Pick<CreatorServicesConfigStore, 'read'>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export async function generateDocumentaryScript(input: GenerateScriptInput): Promise<string> {
  const topic = input.topic.trim() || 'Why Japan Has So Many Empty Houses';
  const durationMinutes = input.targetDurationMinutes && input.targetDurationMinutes > 0
    ? input.targetDurationMinutes
    : 10;
  const targetWords = durationMinutes * 150;
  const tone = input.tone || 'documentary';

  // 1. Try LLM if configured
  if (input.configStore) {
    try {
      const config = await input.configStore.read();
      if (config.llm && config.llm.apiKey.trim()) {
        const response = await fetchCreatorService({
          endpoint: openAiCompatibleEndpoint(config.llm.baseUrl, 'chat/completions'),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.llm.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: config.llm.model,
            messages: [
              {
                role: 'system',
                content: [
                  'You are a professional YouTube documentary scriptwriter and investigative journalist for channels like Vox, Wendover Productions, and Johnny Harris.',
                  'Write compelling, factual, narrative-driven English documentary scripts.',
                  'Structure scripts with clear chapters, dramatic pacing, historical context, economic analysis, and human stories.',
                  'Embed visual camera cues in brackets like [Visual: aerial shot of misty abandoned mountain village] to guide video editors.'
                ].join(' ')
              },
              {
                role: 'user',
                content: [
                  `Write a complete, full-length YouTube documentary script about: "${topic}".`,
                  `Target length: approximately ${targetWords} words (for a ${durationMinutes}-minute documentary video).`,
                  `Tone: ${tone}.`,
                  '',
                  'Required Structure:',
                  '# TITLE: A catchy, high-CTR YouTube documentary title',
                  '',
                  '## [HOOK & INTRO]',
                  'Open with an intriguing, counter-intuitive scene or data point that hooks the viewer within 5 seconds.',
                  '',
                  '## [CHAPTER 1: THE PHENOMENON & SCALE]',
                  'Explore the scope of the issue, numbers, geography, and historical origin.',
                  '',
                  '## [CHAPTER 2: THE ROOT CAUSES]',
                  'Break down the hidden economic, demographic, and legal mechanisms behind it.',
                  '',
                  '## [CHAPTER 3: THE HUMAN REALITY & UNSEEN COSTS]',
                  'Show what life is like on the ground for local communities and individuals.',
                  '',
                  '## [CHAPTER 4: ATTEMPTS TO REVIVE & MODERN INNOVATIONS]',
                  'What solutions are being tried? Who is trying to fix this, and what challenges do they face?',
                  '',
                  '## [CONCLUSION & OUTRO]',
                  'A thought-provoking conclusion on what this teaches us about the future, followed by a brief call to subscribe and share thoughts in the comments.',
                  '',
                  'Output only the final script narration text with [Visual: ...] cues. Do not truncate with placeholder text.'
                ].join('\n')
              }
            ]
          }),
          proxy: config.proxy,
          signal: input.signal ?? new AbortController().signal,
          maxResponseBytes: 3 * 1024 * 1024,
          fetchImpl: input.fetchImpl
        });

        if (response.ok) {
          const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content?.trim();
          if (content && content.length > 200) {
            return content;
          }
        }
      }
    } catch (error) {
      console.warn(`[faceless-script] LLM generation failed, falling back to structured documentary generator: ${error}`);
    }
  }

  // 2. Fallback: High quality structured documentary script generator
  return buildStructuredFallbackScript(topic, durationMinutes);
}

function buildStructuredFallbackScript(topic: string, durationMinutes: number): string {
  const isJapanEmptyHouses = /japan|empty house|akiya/i.test(topic);

  if (isJapanEmptyHouses) {
    return [
      `# Why Japan Has Over 9 Million Abandoned Houses (And Why Nobody Wants Them)`,
      '',
      `## [HOOK & INTRO]`,
      `[Visual: Drone shot sweeping across an overgrown, fog-covered valley in rural Nagano, revealing dozens of silent wooden traditional homes.]`,
      `Across rural Japan, millions of homes sit completely empty, swallowed by nature and abandoned by families who moved away decades ago.`,
      `In Japanese, these properties are known as akiya — literally translated as "empty houses."`,
      `[Visual: Close-up of rusted locks on sliding shoji doors, fallen roof tiles, and mailboxes stuffed with decayed notices from 2005.]`,
      `According to the Japanese government's latest census, there are now over nine million abandoned homes across the country. That is nearly fourteen percent of Japan's entire residential housing stock.`,
      `In some rural prefectures like Wakayama and Tokushima, nearly one in every five houses stands permanently derelict.`,
      `And the strangest part? Many of these homes are being given away for virtually free — or even sold for as little as five hundred dollars. Yet almost nobody is taking them.`,
      `To understand why one of the world's wealthiest and most technologically advanced nations is slowly turning into a ghost country, we have to look past the picturesque countryside and examine a unique collision of demographic collapse, post-war tax incentives, and cultural taboos.`,
      '',
      `## [CHAPTER 1: THE GHOST VILLAGES OF RURAL JAPAN]`,
      `[Visual: Archival black-and-white footage of bustling Tokyo in the 1960s, transitioning to present-day empty train stations with lone elderly passengers.]`,
      `The story of Japan's empty houses begins during the economic miracle of the 1960s and 1970s.`,
      `Following World War Two, Japan experienced unprecedented industrialization. Millions of ambitious young workers migrated from rural prefectures into colossal metropolitan areas like Tokyo, Osaka, and Nagoya.`,
      `Generations of rural families left behind ancestral homes made of pristine cedar and tile, expecting that someone in the lineage would someday return.`,
      `[Visual: Old family portraits left on tatami mats inside an abandoned house, dust motes floating in sunlight.]`,
      `But as time passed, those who stayed behind grew older. Japan today has the world's second-oldest population, with nearly thirty percent of its citizens aged sixty-five or older.`,
      `When elderly parents pass away, their urban children inherit properties hundreds of miles away in towns with no economic prospects, no schools, and no public transit.`,
      `These children face a harsh reality: maintaining an empty wooden home in Japan's humid, typhoon-prone climate requires constant upkeep, termite prevention, and gardening.`,
      `So instead of spending thousands of dollars every year on maintenance, many heirs simply stop visiting. Over years and decades, nature reclaims what human hands once built.`,
      '',
      `## [CHAPTER 2: THE PECULIAR ECONOMICS OF JAPANESE REAL ESTATE]`,
      `[Visual: High-speed timelapse of Tokyo skyline under construction, sleek modern glass towers rising beside aging neighborhoods.]`,
      `In Western countries like the United States, Britain, or Australia, houses are traditionally treated as appreciating assets. A Victorian townhouse in London or a mid-century home in California often becomes more valuable with age.`,
      `In Japan, the housing market operates under the exact opposite philosophy.`,
      `Japanese homes are treated like consumer automobiles: the moment you move in, the structure begins rapidly depreciating.`,
      `[Visual: Infographic showing home depreciation curve — value dropping to zero within 25 to 30 years.]`,
      `Within twenty to thirty years, the building itself is officially considered to have zero economic value. Only the underlying land retains worth.`,
      `This dynamic was heavily reinforced by strict building codes that were repeatedly updated after major earthquakes in 1971 and 1981. Homes built before modern seismic standards are viewed by Japanese banks as dangerous liabilities rather than assets.`,
      `Consequently, banks rarely issue mortgages for used homes, and over eighty percent of Japanese home purchases are for brand-new constructions.`,
      `If an heir wants to tear down an old akiya to sell just the land, they encounter an even stranger financial hurdle: Japan's residential tax code.`,
      `[Visual: Legal documents, tax forms, and property boundary maps overlaid on crumbling structures.]`,
      `Under Japanese property tax law, land with a standing residential building enjoys an eighty-three percent tax discount compared to cleared, empty land.`,
      `The moment an owner bulldozes a decaying home, their annual municipal property taxes instantly multiply sixfold. Demolition itself can easily cost twenty to thirty thousand dollars.`,
      `Faced with the choice between paying thirty thousand dollars to demolish a house only to see their property taxes skyrocket, or simply walking away and leaving the house to rot, millions of property owners rationally choose to do nothing.`,
      '',
      `## [CHAPTER 3: THE SPREAD INTO SUBURBS AND CITIES]`,
      `[Visual: Street-level camera walking through quiet residential alleyways in suburban Tokyo, passing overgrown gardens nestled between pristine residences.]`,
      `For years, the akiya problem was considered a remote curiosity — an issue confined to depopulated mountain valleys and fading fishing ports.`,
      `Today, that is no longer true. Empty houses are rapidly encroaching on major metropolitan commuter zones.`,
      `Even in Tokyo's twenty-three central wards, an estimated eight hundred thousand homes are currently unoccupied.`,
      `In bedroom communities like Chiba and Saitama, entire suburban developments built during the 1980s bubble era are emptying out as original homeowners age without younger generations replacing them.`,
      `[Visual: Firefighters inspecting a collapsed roof, overgrown weeds creating hazards for adjacent neighbors.]`,
      `These abandoned houses create real hazards for the neighbors who remain. Neglected structures become fire traps, breeding grounds for pests, and severe earthquake risks during seismic events.`,
      `When roof tiles fly off during typhoons or walls collapse onto public roads, municipal authorities struggle to intervene because Japanese property laws strictly protect private ownership.`,
      `Finding the legal owner of an abandoned house can be nearly impossible. If an owner passed away without a registered will, ownership fragments across dozens of distant relatives, many of whom don't even know they inherited a fractional share of a crumbling house.`,
      '',
      `## [CHAPTER 4: THE AKIYA HUNTERS AND REVIVAL EFFORTS]`,
      `[Visual: Young foreign couple renovating a wooden farmhouse, installing modern insulation and solar panels.]`,
      `In recent years, the plight of Japan's empty houses has captured international imagination.`,
      `Social media platforms and YouTube are filled with stories of foreigners and young Japanese creatives buying countryside properties for five thousand dollars and transforming them into modern sanctuaries, bed and breakfasts, or remote work studios.`,
      `Many local municipalities have established official "Akiya Banks" — government-run online marketplaces where prospective buyers can browse thousands of discounted properties.`,
      `[Visual: Browsing government Akiya Bank portals showing free listings and renovation subsidies.]`,
      `Some towns offer generous cash subsidies of up to twenty thousand dollars to young families willing to move in and renovate older structures.`,
      `In 2023, the Japanese parliament passed sweeping reforms to combat the crisis. The new legislation allows local governments to strip property tax discounts from severely neglected houses and penalize negligent owners.`,
      `Yet experts caution that these initiatives, while promising, are addressing symptoms rather than the root cause.`,
      `With Japan's population projected to shrink by another twenty million people over the next three decades, there are simply far more houses than people to live in them.`,
      '',
      `## [CONCLUSION & OUTRO]`,
      `[Visual: Atmospheric wide shot of a glowing sunset over the mountains of Japan, juxtaposed with bustling Tokyo neon lights.]`,
      `Japan's empty houses are not merely abandoned structures; they are architectural monuments to a demographic turning point that the rest of the developed world will soon confront.`,
      `From Italy and Spain to South Korea and rural America, falling birthrates and rapid urbanization mean that other nations will inevitably follow Japan down this same path.`,
      `As the world grapples with shifting populations, Japan serves as a living laboratory for what happens when a society builds for perpetual growth, only to find that the future looks entirely different.`,
      `[Visual: Channel logo animation, subscribe button, and end screen cards.]`,
      `What would you do if you were offered a free house in rural Japan? Let us know your thoughts in the comments below, and don't forget to like and subscribe for more deep-dive documentaries. Thank you for watching.`
    ].join('\n');
  }

  return [
    `# The Hidden Reality of ${topic}`,
    '',
    `## [HOOK & INTRO]`,
    `[Visual: Dramatic establishing shot opening on the central subject of ${topic}, setting a cinematic and mysterious tone.]`,
    `When we think about ${topic}, most people assume the story is relatively straightforward.`,
    `We see the headlines, we hear the conventional wisdom, and we move on.`,
    `[Visual: Rapid montage of news headlines, historical archives, and compelling data visualizations.]`,
    `Yet beneath the surface lies a vastly more complex, high-stakes story that almost nobody is talking about.`,
    `In this deep-dive documentary, we explore the origins, the unseen forces, and the profound future implications of ${topic}.`,
    '',
    `## [CHAPTER 1: THE ORIGINS & SCALE]`,
    `[Visual: Archival footage and contextual maps explaining the historical timeline.]`,
    `To truly understand how we arrived at this moment, we have to travel back to where it all began.`,
    `For decades, subtle shifts in economic policy, technological capability, and societal expectations laid the groundwork for what we are witnessing today.`,
    `The numbers alone are staggering: what started as an isolated development has now expanded across global borders, affecting millions of lives and billions of dollars in capital.`,
    '',
    `## [CHAPTER 2: THE UNSEEN DRIVERS]`,
    `[Visual: Analytical breakdown with charts, expert perspectives, and on-the-ground footage.]`,
    `Why is this happening now? The answer involves a convergence of powerful structural incentives.`,
    `When incentives align in unexpected ways, systems produce outcomes that seem irrational from the outside, but are completely logical to the players involved.`,
    `Key institutions and market dynamics created a self-reinforcing cycle that proved nearly impossible to reverse.`,
    '',
    `## [CHAPTER 3: THE HUMAN IMPACT]`,
    `[Visual: Intimate portraits and real-world stories of people directly impacted by ${topic}.]`,
    `Beyond the macro statistics and financial figures, the true cost is felt by everyday individuals on the ground.`,
    `Communities have had to adapt in surprising, resilient ways, navigating uncertainties that previous generations never anticipated.`,
    `These human stories reveal the friction between rapid modernization and lasting traditional values.`,
    '',
    `## [CHAPTER 4: THE PATH FORWARD & FUTURE OUTLOOK]`,
    `[Visual: Forward-looking footage, modern laboratories, and innovative initiatives tackling the challenge.]`,
    `As public attention turns toward ${topic}, new solutions, technologies, and policy experiments are emerging.`,
    `Innovators, researchers, and community leaders are challenging old assumptions and pioneering fresh approaches.`,
    `Whether these solutions can scale in time remains one of the defining questions of our generation.`,
    '',
    `## [CONCLUSION & OUTRO]`,
    `[Visual: Cinematic closing sequence, pulling back to a wide perspective on the global landscape.]`,
    `The story of ${topic} is ultimately a reflection of how our world changes: slowly at first, and then all at once.`,
    `How we respond to this challenge will shape the cultural, economic, and technological landscape for decades to come.`,
    `[Visual: Channel outro card, subscribe prompt, and recommended video links.]`,
    `What are your thoughts on ${topic}? Share your perspective in the comments section below, and subscribe for more in-depth documentaries. Thanks for watching.`
  ].join('\n');
}
