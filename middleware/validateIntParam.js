// @ts-check
// Guard for numeric route params (our ids are SERIAL/INT). Without this a
// non-numeric id like /api/media/abc reaches Postgres as "invalid input syntax
// for integer" and surfaces as a confusing 500. Reject it early with a clean 400.
export const validateIntParam = (name) => (req, res, next) => {
  const value = req.params[name];
  if (!/^\d+$/.test(value)) {
    return res.status(400).json({ message: `Invalid ${name}` });
  }
  next();
};
