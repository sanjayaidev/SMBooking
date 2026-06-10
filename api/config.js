export default function handler(req, res) {
  res.status(200).json({ gasUrl: process.env.GAS_URL });
}
