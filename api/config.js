// api/config.js
module.exports = (req, res) => {
  // Vercel automatically injects environment variables into process.env
  res.status(200).json({
    gasUrl: process.env.GAS_URL || ''
  });
};
