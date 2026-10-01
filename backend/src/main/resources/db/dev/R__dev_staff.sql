-- Development-only (repeatable) staff so the slice can assign an examiner. Loaded only when
-- spring.flyway.locations includes classpath:db/dev (the "dev" profile). Never in production.
INSERT INTO staff_users (handle, display_name, title, team, role, payout_limit) VALUES
    ('rachel', 'Rachel Kim',    'Life claims examiner', 'Life & annuity team', 'life_examiner', 250000.00),
    ('monica', 'Monica Reyes',  'Team lead',            'Life & annuity team', 'team_lead',     1000000.00)
ON CONFLICT (handle) DO NOTHING;
