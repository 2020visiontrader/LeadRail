-- 90 cold-email outreach templates for the account-wide library
-- (BDB Productions, brand_id null = usable across all ventures), 9 categories x 10.
-- Idempotent: unique on (account_id, name) so re-running this file is a no-op.
-- Supersedes any prior template seed: run TRUNCATE/DELETE for this account before
-- replaying if the table already has rows from an earlier, non-matching seed.
ALTER TABLE message_templates ADD CONSTRAINT IF NOT EXISTS message_templates_account_name_key UNIQUE (account_id, name);

INSERT INTO message_templates (account_id, name, category, subject, body) VALUES
('00000000-0000-0000-0000-0000000000b1', 'Value First Intro', 'intro', '3 retention insights for {{company}}', 'Hi {{name}},

I put together three retention insights based on what''s working for creator platforms like yours.

1. Most audience drop-off happens in the first 8 seconds, but the fix isn''t what most people think.
2. Mid-roll retention is the strongest predictor of brand deal renewal.
3. Cross platform benchmarking across YouTube, TikTok, and Instagram reveals gaps most teams miss.

Want me to send over the full breakdown?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Warm Intro for SaaS and Tech', 'intro', 'Quick question about {{company}}''s content analytics', 'Hi {{name}},

I''ve been following {{company}}''s work in the creator space, and it''s impressive traction.

We built RetentionRail to help creator focused platforms answer one question: why do viewers drop off, and what changes move the needle?

Would you be open to a 15 minute call next week? Happy to share what we''re seeing across the industry.

Best,
{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Direct Intro for Agencies and MCNs', 'intro', '{{company}} and RetentionRail: analytics partnership', 'Hey {{name}},

I noticed {{company}} manages a strong roster of creators. We''re working with MCNs to give their talent teams viewer retention data they currently don''t have, the kind that directly impacts brand deal rates and CPM.

Any interest in a 5 minute walkthrough tailored to your roster?

Cheers,
{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Talent Management', 'intro', 'How {{company}} could cut creator churn', 'Hi {{name}},

Managing a roster means brand deals live or die on retention data you can point to. RetentionRail gives talent teams a clean view of where each creator''s audience drops off, and why.

Worth 15 minutes to see it against your own roster?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Production Agencies', 'intro', 'Retention data for {{company}}''s slate', 'Hi {{name}},

Most production agencies still report engagement, not retention, which is what actually predicts renewal. RetentionRail plugs into your existing channels and surfaces drop-off points per episode or series.

Happy to show a live example from a similar slate.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Enterprise Analytics Buyers', 'intro', 'RetentionRail for {{company}}''s analytics stack', 'Hi {{name}},

I know {{company}} already has an analytics stack. RetentionRail isn''t meant to replace it, it fills the one gap most platforms don''t cover well: second by second retention across YouTube, TikTok, and Instagram in one view.

Open to a technical walkthrough with your team?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Pain Point Intro Manual Reporting', 'intro', 'Still building retention reports by hand?', 'Hi {{name}},

A lot of teams we talk to are still pulling retention numbers into spreadsheets manually before every brand deal report. RetentionRail automates that, same data, a fraction of the time.

Want to see what it looks like for {{company}}?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Pain Point Intro Brand Deal Churn', 'intro', 'The metric brands actually renew on', 'Hi {{name}},

Brands are increasingly asking for retention curves, not just views, before renewing. If {{company}} can''t produce that on demand, it''s a real risk at renewal time.

RetentionRail generates it automatically. Worth a quick look?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Trigger Intro New Funding Announcement', 'intro', 'Congrats on the raise, {{name}}', 'Hi {{name}},

Saw the news about {{company}}''s round, congratulations. Scaling usually means the retention and reporting question gets harder before it gets easier.

RetentionRail is built for exactly that stage. Open to a short intro call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Trigger Intro Recent Creator Signing', 'intro', 'Saw {{company}}''s latest signing', 'Hi {{name}},

Congrats on the new signing, always a good moment to make sure your reporting can keep up with a growing roster.

RetentionRail scales retention analytics per creator without extra manual work on your team''s end. Want a quick look?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Case Study Follow Up', 'follow-up', 'Thought this {{company}} case study might resonate', 'Hi {{name}},

I came across a retention case study and it reminded me of {{company}}''s setup, specifically the part about reducing early drop-off by 34% with segmented benchmarks.

Here''s the link: [case study URL]

Would love to hear if anything in there aligns with what you''re working on.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Social Proof Follow Up', 'follow-up', 'Results from teams similar to {{company}}', 'Hey {{name}},

Since I last reached out, two teams similar to {{company}} started using RetentionRail to track audience retention across platforms.

One saw a 22% lift in average watch time within the first month. The other uses it for brand deal reporting.

If you''re curious, I can share the specifics.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Gentle Nudge', 'follow-up', 'Following up, {{name}}', 'Hi {{name}},

Just circling back on my note from earlier this week. I know things get busy.

If now isn''t the right time, happy to reconnect in a few weeks, just let me know either way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Data Point Hook', 'follow-up', 'One stat worth sharing, {{name}}', 'Hi {{name}},

One data point from our platform this week: creators over 250K subscribers are losing an average 18% more viewers in the first 15 seconds than six months ago.

If that''s relevant to {{company}}, happy to dig deeper together.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Competitor Benchmark', 'follow-up', 'How {{company}} compares on retention', 'Hi {{name}},

We can benchmark {{company}}''s retention curves against anonymized peers in your category. Most teams are surprised by where they actually stand.

Want me to run that comparison for you, no strings attached?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up One Question', 'follow-up', 'Quick one for {{name}}', 'Hi {{name}},

Is retention and drop-off reporting something {{company}} is actively trying to improve right now, or is it further down the list?

Either answer is useful, just trying to time this right.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Free Audit Offer', 'follow-up', 'Free retention audit for {{company}}', 'Hi {{name}},

Happy to run a free retention audit on two or three of {{company}}''s top performing videos, no commitment, just a look at where you''re losing viewers and why.

Send over the links whenever works.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Resource Share', 'follow-up', 'A resource that might save you time', 'Hi {{name}},

Putting together our retention reporting checklist reminded me of our earlier conversation. I''ll send it over, it''s the exact framework we use internally before a brand deal renewal.

Let me know if it''s useful for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Second Follow Up', 'follow-up', 'Still worth a look?', 'Hi {{name}},

Following up once more, no pressure if the timing''s off. If retention analytics is on {{company}}''s radar for this quarter, I''d still love to show you what we''ve built.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Final Follow Up', 'follow-up', 'Last follow up from me, {{name}}', 'Hi {{name}},

This will be my last note on this for now. I don''t want to clutter your inbox. If priorities shift and retention reporting becomes relevant for {{company}}, just reply and I''ll pick this back up.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Permission to Close', 'break-up', 'Should I keep {{company}} on my radar?', 'Hey {{name}},

I want to be respectful of your inbox. If RetentionRail isn''t a fit for {{company}} right now, no hard feelings, just let me know and I''ll stop reaching out.

If it is on the roadmap, I''m happy to keep you updated as we roll out new features.

Either way, appreciate your time.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Final Check In', 'break-up', 'Closing the loop on {{company}}', 'Hi {{name}},

I''ve reached out a couple times and haven''t heard back, totally understand if the timing isn''t right.

I''ll stop here, but if retention analytics ever becomes a priority for {{company}}, the door''s always open.

Wishing you and the team the best.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Light Touch', 'break-up', 'Taking the hint, {{name}}', 'Hi {{name}},

I''ve reached out enough times that I don''t want to be another notification in your inbox. I''ll stop here, but if retention data ever becomes a priority for {{company}}, you know where to find me.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Door Open', 'break-up', 'Closing this out for now', 'Hi {{name}},

I''ll stop following up for now so I''m not adding noise. If anything changes on {{company}}''s side, the door''s open any time, no need to explain why it''s been a while.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up One Last Idea', 'break-up', 'One last thing before I go quiet', 'Hi {{name}},

Before I stop reaching out, here''s one framework we give every prospect regardless of outcome: track first 15 second drop-off weekly, it''s the single best early warning signal for renewal risk.

Hope it''s useful for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Timing Not Right', 'break-up', 'Understood on timing', 'Hi {{name}},

Sounds like this isn''t the right moment for {{company}}, and that''s completely fine. I''ll close this out on my end, feel free to reach out whenever the timing changes.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Reassign to Colleague', 'break-up', 'Right person for this?', 'Hi {{name}},

I may have the wrong person for this conversation. If someone else at {{company}} owns retention or creator analytics, I''d appreciate a pointer, otherwise I''ll close this thread.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Short and Direct', 'break-up', 'Closing the loop', 'Hi {{name}},

Haven''t heard back, so I''ll assume the timing isn''t right and stop here. Feel free to reach out if that changes.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Feedback Ask', 'break-up', 'Genuinely curious, {{name}}', 'Hi {{name}},

Before I close this out, genuinely curious if there''s a reason retention analytics isn''t a fit for {{company}} right now. Any quick feedback helps me not waste your time in future.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Long Term Opt In', 'break-up', 'Okay to check back in a few months?', 'Hi {{name}},

I''ll stop the regular outreach, but would it be alright if I checked back in a quarter or two, once {{company}}''s priorities may have shifted? Just say the word either way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Request Warm', 'referral', 'Do you know anyone who''d benefit from retention analytics?', 'Hi {{name}},

Thanks again for the conversation last month, really enjoyed hearing about {{company}}''s approach.

I''m currently connecting with more creator platforms and MCNs. If anyone in your network comes to mind who''s wrestling with audience retention or brand deal analytics, I''d be grateful for an intro.

No pressure at all.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Ask Post Demo', 'referral', 'Know other teams tackling retention?', 'Hi {{name}},

Glad the demo resonated. One quick ask: if you know other creator teams or agencies who''d find this useful, I''d love an introduction.

Happy to return the favor however I can.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Post Signup', 'referral', 'Know anyone else who''d benefit?', 'Hi {{name}},

Glad {{company}} is up and running on RetentionRail. If any other teams in your network are wrestling with retention reporting, I''d really appreciate an introduction.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Community or Event', 'referral', 'Great meeting you, {{name}}', 'Hi {{name}},

Really enjoyed our conversation earlier. If any other creator teams or MCNs from that event come to mind who might find retention analytics useful, I''d love an intro.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Incentive Offer', 'referral', 'A thank you for any intros', 'Hi {{name}},

If you introduce us to another creator team or MCN that ends up signing on, we''ll credit {{company}}''s account for a month, no strings attached. Just a small thank you for spreading the word.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Existing Customer Champion', 'referral', 'Would you be open to a quick intro?', 'Hi {{name}},

Given how well things have gone for {{company}} with RetentionRail, would you be open to introducing us to one or two other teams who might benefit similarly?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Investor Network', 'referral', 'Portfolio companies that might fit?', 'Hi {{name}},

If any companies in your portfolio manage creator relationships or run audience facing content, I''d love an introduction. RetentionRail tends to be a strong fit for that profile.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Partner Network', 'referral', 'Clients that might need this?', 'Hi {{name}},

If any of {{company}}''s clients are asking for better retention reporting, I''d welcome an introduction. Happy to make you look good in the process.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Post Case Study', 'referral', 'Loved being featured, one small ask', 'Hi {{name}},

Thanks again for letting us feature {{company}} in our case study. If it resonates with anyone else in your network, I''d love an introduction, happy to return the favor.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral LinkedIn Comment Trigger', 'referral', 'Saw your comment on retention data', 'Hi {{name}},

Saw your comment about retention reporting pain points, sounds like something we solve daily at RetentionRail. If you know others discussing the same thing, feel free to point them my way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Weekly Insight Drop', 'nurture', 'Creator retention trend: what''s shifting this month', 'Hi {{name}},

Quick insight from our data this month: TikTok retention curves are flattening for creators over 500K followers, while YouTube Shorts retention is actually improving.

If {{company}} has creators in that range, this might be worth a look.

I send these out weekly, let me know if you''d like to be added.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Industry Report Share', 'nurture', 'Just published: Creator Retention Benchmarks Q3', 'Hi {{name}},

We just released our Q3 Creator Retention Benchmarks report, it covers YouTube, TikTok, and Instagram across 12 creator tiers.

Thought {{company}} might find the platform comparison section useful. Happy to send it over.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Feature Update Notification', 'nurture', 'New: cross platform retention dashboards', 'Hey {{name}},

Quick heads up, we just shipped cross platform retention dashboards. Creators can now compare their YouTube, TikTok, and Instagram retention curves side by side.

If {{company}} manages multi platform talent, this might save your team a lot of manual work.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Customer Spotlight', 'nurture', 'How one team cut drop-off by 22%', 'Hi {{name}},

A creator team similar to {{company}} used RetentionRail''s segmented benchmarks to cut early drop-off by 22% in six weeks. Happy to share exactly what they changed.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Webinar Invite', 'nurture', 'Webinar: retention benchmarks for creator teams', 'Hi {{name}},

We''re running a short webinar next week on reading retention curves for brand deal reporting. Thought it might be useful for {{company}}''s team, happy to send the link.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Comparison Guide', 'nurture', 'A quick platform comparison guide', 'Hi {{name}},

Put together a short guide comparing YouTube, TikTok, and Instagram retention patterns for mid size creators. Thought it would be a useful reference for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Quarterly Check In', 'nurture', 'Checking in for the new quarter', 'Hi {{name}},

As {{company}} plans out this quarter, wanted to flag that retention reporting tends to get harder right before renewal season. Happy to help you get ahead of it.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Roadmap Preview', 'nurture', 'What we''re shipping next', 'Hi {{name}},

Wanted to give {{company}} a preview of what''s coming: automated brand deal ready reports and creator level churn alerts, both shipping next month.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Milestone Announcement', 'nurture', 'We just crossed a milestone', 'Hi {{name}},

RetentionRail just crossed 50 creator platforms on the product, wanted to share since {{company}} has been part of the conversation along the way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Educational Tip', 'nurture', 'A retention tip worth testing', 'Hi {{name}},

Quick tip: moving your strongest hook to the 3 second mark instead of the intro typically improves 15 second retention by 8 to 12 percent. Worth testing on {{company}}''s next upload.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Request Direct', 'demo', 'RetentionRail demo for {{company}}?', 'Hi {{name}},

Would a 20 minute walkthrough of RetentionRail be useful? I can tailor it to {{company}}''s creator portfolio, showing retention curves and drop-off points specific to your niche.

This week: Tuesday after 2pm or Thursday morning.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Team Onboarding', 'demo', 'Team demo: RetentionRail for {{company}}', 'Hi {{name}},

If your whole talent team would benefit from seeing RetentionRail in action, I''m happy to run a group session.

We can cover reading retention curves for brand deals, cross platform comparisons, and flagging at risk creator accounts.

30 minutes, I''ll adapt to whatever works for your team.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Executive Briefing', 'demo', 'A short executive level briefing?', 'Hi {{name}},

Happy to run a condensed, executive level version of the RetentionRail demo for {{company}}''s leadership, 15 minutes, focused on the business impact rather than the tooling.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Live Data Walkthrough', 'demo', 'Want to see {{company}}''s own data?', 'Hi {{name}},

Instead of a generic demo, I can pull a sample of {{company}}''s actual public content into RetentionRail and walk through the real retention curves live.

Want me to set that up?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Post Trial Follow Up', 'demo', 'How''s the trial going, {{name}}?', 'Hi {{name}},

Wanted to check in on how the trial has been for {{company}} so far, happy to jump on a call to answer questions or dig into anything specific in the data.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Reschedule Offer', 'demo', 'No worries, want to reschedule?', 'Hi {{name}},

No problem at all if the original time didn''t work. Let me know a few slots that suit {{company}}''s team and I''ll get something on the calendar.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo No Show Recovery', 'demo', 'Missed you earlier, still happy to connect', 'Hi {{name}},

Looks like we missed each other for the scheduled call. Totally understand things come up, let me know a better time and I''ll rebook for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Competitive Comparison', 'demo', 'Evaluating a few analytics tools?', 'Hi {{name}},

If {{company}} is comparing a few retention and analytics tools side by side, happy to set up RetentionRail so you can benchmark it directly against the others on the same content.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Free Pilot Offer', 'demo', '30 day pilot for {{company}}', 'Hi {{name}},

Would a free 30 day pilot help {{company}} evaluate RetentionRail properly before any commitment? I can get it set up on your top channels this week.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Custom ROI Model', 'demo', 'A custom ROI model for {{company}}', 'Hi {{name}},

I can build a quick ROI model specific to {{company}}''s roster size and average deal value, so the demo isn''t abstract, it''s tied to numbers your team already tracks.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Pitch Cold', 'investor', 'RetentionRail: creator analytics investment', 'Hi {{name}},

I know you focus on creator economy investments. RetentionRail is a creator analytics platform that helps MCNs and agencies understand exactly where audiences drop off, and what to do about it.

We''re seeing strong traction with mid market creator platforms, 30 plus customers and a $180K ARR pipeline in Q3.

Would you be open to a brief intro call to discuss?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Referral from Founder', 'investor', '{{referrer}} suggested I reach out', 'Hi {{name}},

{{referrer}} suggested I connect with you about RetentionRail. They thought our creator analytics platform would be relevant to your portfolio.

We help creator platforms and MCNs understand audience retention, which directly impacts CPM, brand deal rates, and churn.

Would you have 15 minutes next week?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Update Pipeline', 'investor', 'RetentionRail Q3 pipeline update', 'Hi {{name}},

Quick update on RetentionRail: 30 active pilots across MCNs and creator platforms, $1.85M in pipeline with an average deal size of $110K, and we just shipped cross platform dashboards.

Happy to walk through the latest deck if you''d like a refresher.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Warm Intro via Portfolio Company', 'investor', '{{referrer}} suggested we connect', 'Hi {{name}},

{{referrer}} mentioned you invest in creator economy infrastructure and thought RetentionRail would be relevant given our traction with MCNs and analytics platforms.

Open to a short intro call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Traction Milestone', 'investor', 'A quick milestone update', 'Hi {{name}},

Wanted to flag a milestone: RetentionRail just crossed 50 active creator platforms with strong expansion revenue from existing accounts. Happy to share the details if useful.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Follow On Round', 'investor', 'Opening up our next round soon', 'Hi {{name}},

We''re starting conversations ahead of our next round and thought you''d want an early look given your focus on creator economy tools. Would a brief call make sense?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Market Sizing Angle', 'investor', 'The retention analytics gap', 'Hi {{name}},

Most creator platforms report views and engagement, but almost none report retention well, a gap we think is worth several hundred million as MCNs and platforms professionalize reporting.

Would love your take.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Thesis Fit', 'investor', 'Might fit your thesis on creator infrastructure', 'Hi {{name}},

Given your public writing on creator economy infrastructure, RetentionRail''s approach to retention analytics for MCNs seemed like a natural fit to share.

Open to trading notes?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Post Meeting Recap', 'investor', 'Thanks for the time, {{name}}', 'Hi {{name}},

Thanks again for the conversation. As discussed, I''ll follow up with the deck and the customer references, let me know if anything else would help as you evaluate.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Monthly Update', 'investor', 'Monthly update: RetentionRail', 'Hi {{name}},

Quick monthly update: ARR up 14% month over month, two new MCN pilots signed, and our cross platform dashboard shipped ahead of schedule. Happy to go deeper on any of it.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partnership Exploration', 'partner', '{{company}} and RetentionRail partnership', 'Hi {{name}},

I''ve been looking at {{company}}''s creator ecosystem and think there could be a natural partnership with RetentionRail.

Our retention analytics could add value to your creator clients, and your distribution could help us reach more teams.

Worth exploring over a call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Integration Partner Pitch', 'partner', 'API integration: RetentionRail and {{company}}', 'Hi {{name}},

We''re exploring integration partners and {{company}} came up as a strong fit. RetentionRail''s retention data could feed directly into your platform, giving your users real time audience drop-off insights.

Our API is ready, would love to explore a pilot integration.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Co Marketing Proposal', 'partner', 'Co marketing idea for {{company}} and RetentionRail', 'Hi {{name}},

Our audiences overlap closely, creator teams and MCNs. Would {{company}} be open to a joint webinar or content piece on retention analytics for the creator economy?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Reseller Program', 'partner', 'Reseller opportunity with RetentionRail', 'Hi {{name}},

We''re building out a reseller program for agencies like {{company}} that already manage analytics relationships with creator clients. Worth a conversation about terms?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Data Sharing Agreement', 'partner', 'A data sharing partnership?', 'Hi {{name}},

RetentionRail''s retention data paired with {{company}}''s platform metrics could give both our users a much fuller picture. Open to exploring a data sharing agreement?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Event Co Sponsorship', 'partner', 'Co sponsoring an upcoming event?', 'Hi {{name}},

We''re evaluating sponsorships for the next creator economy conference and thought {{company}} might want to split the booth and content slot with us. Interested?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Agency Referral Program', 'partner', 'Referral program for agencies like {{company}}', 'Hi {{name}},

We''re setting up a formal referral arrangement for agencies that regularly work with creator platforms. Would {{company}} want to be one of the first partners?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Marketplace Listing', 'partner', 'Listing RetentionRail in your marketplace', 'Hi {{name}},

Would {{company}} be open to listing RetentionRail in your integrations marketplace? Our retention data would give your users a feature they currently have to source elsewhere.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Joint Case Study', 'partner', 'A joint case study, {{name}}?', 'Hi {{name}},

Given how well the integration between {{company}} and RetentionRail has worked, would you be open to co-authoring a case study? Good exposure for both of us.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Renewal Check In', 'partner', 'Checking in on the partnership', 'Hi {{name}},

As we come up on renewal for the {{company}} partnership, wanted to check in on how things have gone and whether there''s room to expand the integration further.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Long Time No Talk', 'reengagement', 'Been a while, {{name}}', 'Hi {{name}},

It''s been a while since we last talked about retention analytics for {{company}}. A lot has changed on our end since then, worth a quick reconnect?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement What Changed Since', 'reengagement', 'What''s changed for {{company}} since we last spoke', 'Hi {{name}},

Curious what''s changed for {{company}}''s creator strategy since we last spoke. Happy to share what''s new on our side too if it''s useful timing.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement New Feature Trigger', 'reengagement', 'The feature you asked about is live', 'Hi {{name}},

You''d mentioned wanting cross platform comparisons the last time we spoke, that''s live now. Worth taking another look for {{company}}?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Reintroduction After Silence', 'reengagement', 'Reintroducing myself, {{name}}', 'Hi {{name}},

It''s been long enough that a proper reintroduction seems fair. I''m still with RetentionRail, and we''ve grown a lot since we last connected. Open to catching up?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Win Back Offer', 'reengagement', 'A one time offer to come back', 'Hi {{name}},

We''d love to have {{company}} take another look at RetentionRail. Happy to offer a free onboarding month if now''s a better time than before.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Industry Shift Angle', 'reengagement', 'The retention conversation has shifted', 'Hi {{name}},

Retention reporting has become table stakes for brand deals since we last spoke. Thought it was worth flagging in case it changes the calculus for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Check Current Priorities', 'reengagement', 'Still not the right time?', 'Hi {{name}},

Just checking whether retention analytics has moved up {{company}}''s priority list since we last spoke, or if it''s still not the right time.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Personal Note', 'reengagement', 'Good to have met you at the event', 'Hi {{name}},

Good connecting in person a while back, realized I never properly followed up. Still think RetentionRail could be a fit for {{company}}. Worth a quick call now?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Referral Reconnect', 'reengagement', '{{referrer}} reminded me to follow up', 'Hi {{name}},

{{referrer}} mentioned {{company}} recently and it reminded me we hadn''t reconnected in a while. Wanted to see if retention reporting is on your radar again.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Final Note', 'reengagement', 'Last note before I archive this thread', 'Hi {{name}},

I''ll archive this thread after this note unless something''s changed for {{company}}. If retention analytics becomes relevant again, just reply and I''ll pick it right back up.

{{sender}}')
ON CONFLICT (account_id, name) DO NOTHING;
