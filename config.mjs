// Identity of the company and of its human owner. Everything here comes from the environment (see .env.example).
export const CFG = {
  company: process.env.COMPANY_NAME || "AlphaPulse",
  legal: process.env.COMPANY_LEGAL_NAME || "Your Company LLC",
  legalAddress: process.env.COMPANY_LEGAL_ADDRESS || "",
  host: process.env.HOSTING_PROVIDER || "",
  contact: process.env.CONTACT_EMAIL || "contact@example.com",
  site: process.env.COMPANY_WEBSITE || "https://github.com/",
  owner: process.env.OWNER_NAME || "Owner",
  telegramBot: process.env.TELEGRAM_BOT_USERNAME || "",
};
