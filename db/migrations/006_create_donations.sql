CREATE TYPE donation_type AS ENUM ('one_time', 'monthly');
CREATE TYPE donation_status AS ENUM ('pending', 'completed', 'failed');

CREATE TABLE donations (
  id SERIAL PRIMARY KEY,
  donor_id INT REFERENCES users(id),
  amount_cents INT NOT NULL,
  currency VARCHAR(3) DEFAULT 'ILS',
  type donation_type NOT NULL,
  stripe_payment_intent TEXT,
  status donation_status DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
