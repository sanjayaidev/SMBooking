// api/config.js
export default function handler(req, res) {
  // Vercel automatically injects environment variables into process.env
  const gasUrl = process.env.GAS_URL || '';
  
  res.status(200).json({
    gasUrl: gasUrl
  });
}
