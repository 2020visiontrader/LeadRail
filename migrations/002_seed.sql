INSERT INTO brands (id, name, logo_url, active) VALUES
('rentahub', 'Rentahub', 'https://example.com/rentahub.png', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Segments constrained to the app's Segment union:
-- investor | vc | angel | founder | media | partner | other
INSERT INTO contacts (brand_id, name, email, company, title, segment, score) VALUES
('rentahub', 'John Doe', 'john@example.com', 'TechVentures Inc', 'CEO', 'investor', 85),
('rentahub', 'Jane Smith', 'jane@example.com', 'VC Funds LLC', 'Partner', 'vc', 92),
('rentahub', 'Bob Johnson', 'bob@example.com', 'Angel Collective', 'Angel Investor', 'angel', 78),
('rentahub', 'Alice Brown', 'alice@example.com', 'Studio Productions', 'Producer', 'partner', 88),
('rentahub', 'Charlie Davis', 'charlie@example.com', 'Film Agency Co', 'Manager', 'partner', 72),
('rentahub', 'Diana Miller', 'diana@example.com', 'ContentHouse', 'Creator', 'media', 65),
('rentahub', 'Eve Wilson', 'eve@example.com', 'Global Studios', 'Director', 'founder', 84),
('rentahub', 'Frank Thomas', 'frank@example.com', 'Capital Partners', 'Founder', 'investor', 91),
('rentahub', 'Grace Lee', 'grace@example.com', 'Digital Ventures', 'VP Strategy', 'vc', 87),
('rentahub', 'Henry Martin', 'henry@example.com', 'Bootstrap Fund', 'Angel', 'angel', 75),
('rentahub', 'Ivy Chen', 'ivy@example.com', 'Media Group', 'Executive Producer', 'partner', 89),
('rentahub', 'Jack Anderson', 'jack@example.com', 'Creative Agency', 'Account Manager', 'partner', 70),
('rentahub', 'Kate Martinez', 'kate@example.com', 'YouTube Stars', 'Influencer', 'media', 68),
('rentahub', 'Leo Garcia', 'leo@example.com', 'Production House', 'Head of Production', 'founder', 86),
('rentahub', 'Mia Rodriguez', 'mia@example.com', 'Tech Investments', 'Principal', 'investor', 90),
('rentahub', 'Noah Taylor', 'noah@example.com', 'Venture Fund', 'Senior Partner', 'vc', 94),
('rentahub', 'Olivia White', 'olivia@example.com', 'New Angels', 'Angel Investor', 'angel', 76),
('rentahub', 'Peter Harris', 'peter@example.com', 'Indie Films', 'Producer', 'partner', 85),
('rentahub', 'Quinn Campbell', 'quinn@example.com', 'Marketing Firm', 'Director', 'partner', 73),
('rentahub', 'Rachel Green', 'rachel@example.com', 'Streaming Network', 'Content Creator', 'media', 69),
('rentahub', 'Sam Jackson', 'sam@example.com', 'Movie Studio', 'Exec Producer', 'founder', 88),
('rentahub', 'Tina Lopez', 'tina@example.com', 'Founders Club', 'Co-Founder', 'investor', 93),
('rentahub', 'Uma Patel', 'uma@example.com', 'Growth Fund', 'Managing Director', 'vc', 91),
('rentahub', 'Victor King', 'victor@example.com', 'Angel Network', 'Member', 'angel', 74),
('rentahub', 'Wendy Zhang', 'wendy@example.com', 'Production Co', 'Line Producer', 'partner', 83),
('rentahub', 'Xavier Scott', 'xavier@example.com', 'Brand Agency', 'Creative Lead', 'partner', 71),
('rentahub', 'Yara Moore', 'yara@example.com', 'Podcast Network', 'Host', 'media', 67),
('rentahub', 'Zoe Adams', 'zoe@example.com', 'Film Factory', 'Development', 'founder', 82),
('rentahub', 'Aaron Bell', 'aaron@example.com', 'Seed Fund', 'Founder', 'investor', 89),
('rentahub', 'Bella Stone', 'bella@example.com', 'Impact Fund', 'Partner', 'vc', 92);
