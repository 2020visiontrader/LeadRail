export const SEGMENT_SCORES: Record<string, number> = {
  investor: 0.9,
  vc: 0.85,
  angel: 0.8,
  studio: 0.75,
  production: 0.7,
  agency: 0.65,
  creator: 0.6,
  other: 0.4,
};

export const TITLE_KEYWORDS: Record<string, number> = {
  ceo: 1.0,
  founder: 1.0,
  partner: 0.95,
  producer: 0.9,
  director: 0.85,
  'executive producer': 0.88,
  manager: 0.7,
  'account manager': 0.65,
  developer: 0.6,
  designer: 0.6,
  analyst: 0.5,
};

export function scoreContact(segment: string, title: string, engagementEvents: number = 0): number {
  const companyFit = SEGMENT_SCORES[segment.toLowerCase()] || 0.4;
  const titleLower = title.toLowerCase();
  
  let titleMatch = 0.5;
  for (const [keyword, score] of Object.entries(TITLE_KEYWORDS)) {
    if (titleLower.includes(keyword)) {
      titleMatch = score;
      break;
    }
  }
  
  const socialEngagementScore = Math.min(engagementEvents / 10, 1.0);
  return Math.round((companyFit * 0.4 + titleMatch * 0.3 + socialEngagementScore * 0.3) * 100);
}
