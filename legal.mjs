// Public shop pages that must always exist: designed store home (when no "accueil" site is published) and legal pages.
// Company facts come from the environment (config.mjs): legal name, address, hosting provider, contact. Payments: Chain2Pay.
import { CFG } from "./config.mjs";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CONTACT = CFG.contact;
export const LEGAL_LINKS = `<a href="/legal/mentions-legales">Mentions légales</a> · <a href="/legal/cgv">CGV</a> · <a href="/legal/confidentialite">Confidentialité</a>`;

export function storePage(title, inner, { desc = "", index = true } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ""}${index ? "" : '<meta name="robots" content="noindex">'}
<link rel="icon" href="/_brand/favicon-64.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/_kit/kit.css"><script src="/_kit/kit.js" defer></script><script src="/_kit/motion.js" defer></script>
<style>:root{--k-accent:#6d5efc;--k-accent2:#22d3ee;--k-bg:#06070d;--k-bg2:#0c0f1a;--k-display:"Sora",var(--k-font)}
html{background:var(--k-bg)}body{min-height:100vh;display:flex;flex-direction:column}main{flex:1}
.st-top{padding:22px 0}.st-top img{height:30px;width:auto}.st-hero{padding:clamp(48px,9vw,110px) 0 clamp(28px,5vw,48px)}
.st-hero h1{font:800 clamp(2.1rem,5.4vw,3.9rem)/1.04 var(--k-display);letter-spacing:-.03em;max-width:15ch;margin:16px 0 18px}
.st-hero p{color:var(--k-mut);max-width:58ch;font-size:1.06rem}
.st-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,330px),1fr));gap:20px;padding-bottom:90px}
.st-card{display:flex;flex-direction:column;gap:12px;padding:26px;border-radius:22px;text-decoration:none;color:var(--k-fg);transition:transform .25s,border-color .25s}
.st-card:hover{transform:translateY(-4px)}.st-card .k-badge{align-self:flex-start}.st-card h2{font:700 1.3rem/1.2 var(--k-display);margin:0}.st-card p{color:var(--k-mut);margin:0;font-size:.95rem}
.st-price{font:800 1.6rem var(--k-display)}.st-price small{font:500 .8rem var(--k-font);color:var(--k-mut);margin-left:6px}
.st-go{margin-top:auto;display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--k-accent2)}
.st-legal{max-width:760px;padding:40px 0 90px}.st-legal h1{font:800 clamp(1.9rem,4vw,2.6rem) var(--k-display);margin-bottom:8px}.st-legal h2{font:700 1.15rem var(--k-display);margin:30px 0 8px}
.st-legal p,.st-legal li{color:var(--k-mut);line-height:1.7}.st-legal a{color:var(--k-accent2)}
.st-foot{padding:26px 0;border-top:1px solid var(--k-line);color:var(--k-mut);font-size:13px}.st-foot a{color:var(--k-mut)}.st-foot .k-container{display:flex;flex-wrap:wrap;gap:10px 24px;justify-content:space-between}</style></head>
<body><div class="k-mesh" style="position:fixed"><span></span><span></span><span></span></div><div class="k-noise"></div>
<header class="st-top"><div class="k-container"><a href="/" aria-label="Accueil"><img src="/_brand/logo-light.webp" alt="AlphaPulse"></a></div></header>
<main>${inner}</main>
<footer class="st-foot"><div class="k-container"><span>Édité par ${esc(CFG.legal)} · <a href="mailto:${CONTACT}">${CONTACT}</a></span><span>${LEGAL_LINKS}</span></div></footer></body></html>`;
}

/** Store home: every active product that has a published sales page. */
export function storeHome(products) {
  const cards = products.map((p) => {
    const price = Number(p.price).toLocaleString("fr-FR", { minimumFractionDigits: Number(p.price) % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return `<a class="st-card k-glass k-border-anim" href="/${esc(p.site)}/" data-reveal><span class="k-badge">Produit numérique</span><h2>${esc(p.name)}</h2><p>${esc(String(p.description || "").slice(0, 220))}</p><div class="st-price">${price}<small>${esc(p.currency)} · paiement unique</small></div><span class="st-go">Voir le produit <svg class="k-ic"><use href="/_kit/icons.svg#arrow-right"/></svg></span></a>`;
  }).join("");
  return storePage(`${CFG.company} · Boutique`, `<section class="st-hero"><div class="k-container"><span class="k-badge">Boutique ${esc(CFG.company)}</span><h1 data-split>Des outils numériques prêts à l'emploi.</h1><p>Templates, guides et outils pour mieux s'organiser et travailler plus vite. Paiement sécurisé par carte, téléchargement immédiat, garantie 14 jours.</p></div></section>
<section><div class="k-container st-grid">${cards || '<p style="color:var(--k-mut)">Les premiers produits arrivent.</p>'}</div></section>`, { desc: "Boutique : templates et outils numériques prêts à l'emploi, téléchargement immédiat." });
}

const LEGAL = {
  "mentions-legales": ["Mentions légales", `
<h2>Éditeur du site</h2><p>${esc(CFG.legal)}${CFG.legalAddress ? ", " + esc(CFG.legalAddress) : ""}.<br>Contact : <a href="mailto:${CONTACT}">${CONTACT}</a>.<br>Directeur de la publication : le représentant légal de ${esc(CFG.legal)}.</p>
<h2>Hébergement</h2><p>${esc(CFG.host || "(renseigner HOSTING_PROVIDER)")}</p>
<h2>Paiement</h2><p>Les paiements sont traités par le prestataire Chain2Pay sur sa propre page sécurisée. Aucune donnée de carte bancaire ne transite par ce site ni n'est conservée par l'éditeur.</p>
<h2>Propriété intellectuelle</h2><p>Les contenus de ce site et les produits vendus (textes, templates, visuels) sont protégés. Toute reproduction ou revente sans autorisation est interdite.</p>`],
  cgv: ["Conditions générales de vente", `
<h2>1. Objet</h2><p>Les présentes conditions régissent la vente de produits numériques (templates, guides, fichiers téléchargeables) par ${esc(CFG.legal)} sur ce site. Toute commande vaut acceptation de ces conditions.</p>
<h2>2. Produits</h2><p>Chaque page produit décrit précisément le contenu livré, son format et ce qu'il faut pour l'utiliser. Les visuels de démonstration sont des illustrations avec des données d'exemple.</p>
<h2>3. Prix et paiement</h2><p>Les prix sont indiqués en euros, pour un paiement unique, sans abonnement. Le paiement s'effectue par carte sur la page sécurisée du prestataire Chain2Pay.</p>
<h2>4. Livraison</h2><p>Dès la confirmation du paiement, la page de commande affiche le lien de téléchargement du produit (fichier ZIP). Cette page reste accessible pour retélécharger le produit, y compris ses mises à jour.</p>
<h2>5. Droit de rétractation et garantie</h2><p>Pour un contenu numérique fourni immédiatement, le droit légal de rétractation ne s'applique plus une fois le téléchargement commencé avec l'accord de l'acheteur. En plus de ce cadre légal, ${esc(CFG.legal)} offre une garantie satisfait ou remboursé de 14 jours : sur simple email à <a href="mailto:${CONTACT}">${CONTACT}</a> dans les 14 jours suivant l'achat, le prix payé est remboursé intégralement.</p>
<h2>6. Licence d'utilisation</h2><p>L'acheteur reçoit une licence personnelle, non exclusive et non transférable. Il peut utiliser et adapter le produit pour ses propres besoins, mais pas le revendre, le redistribuer ou le partager publiquement.</p>
<h2>7. Support</h2><p>Une question sur un produit : <a href="mailto:${CONTACT}">${CONTACT}</a>. Nous répondons en jours ouvrés.</p>
<h2>8. Responsabilité</h2><p>Les produits sont fournis tels que décrits. ${esc(CFG.legal)} ne peut être tenue responsable d'un usage non conforme à leur description ni des services tiers utilisés avec eux (par exemple Notion).</p>
<h2>9. Droit applicable</h2><p>Les présentes conditions sont régies par le droit du pays d'immatriculation de l'éditeur, sans préjudice des dispositions impératives protectrices du consommateur de son pays de résidence. En cas de difficulté, contactez-nous d'abord par email : la plupart des situations se règlent ainsi.</p>`],
  confidentialite: ["Politique de confidentialité", `
<h2>Données collectées</h2><p>Lors d'un achat : l'adresse email et les informations de commande nécessaires à la livraison et au support. Les données de carte bancaire sont traitées uniquement par le prestataire de paiement Chain2Pay. Lors d'un échange par email : le contenu de vos messages.</p>
<h2>Utilisation</h2><p>Ces données servent uniquement à exécuter la commande, livrer le produit, répondre à vos questions et respecter nos obligations comptables. Elles ne sont ni vendues ni louées.</p>
<h2>Sous-traitants</h2><p>Hébergement : ${esc(CFG.host || "l'hébergeur du site")}. Paiement : Chain2Pay. Ces prestataires traitent les données uniquement pour fournir leur service.</p>
<h2>Cookies et mesure d'audience</h2><p>Ce site ne dépose pas de cookie publicitaire ni de traceur tiers. Un simple compteur de visites, sans cookie et sans donnée personnelle, mesure la fréquentation des pages.</p>
<h2>Durée de conservation</h2><p>Les données de commande sont conservées le temps nécessaire au support et aux obligations comptables, puis supprimées.</p>
<h2>Vos droits</h2><p>Vous pouvez demander l'accès, la rectification ou la suppression de vos données à tout moment en écrivant à <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`],
};
export function legalPage(kind) {
  const l = LEGAL[kind]; if (!l) return null;
  return storePage(`${l[0]} · ${CFG.company}`, `<div class="k-container st-legal"><h1>${l[0]}</h1><p>Dernière mise à jour : octobre 2026.</p>${l[1]}</div>`, { index: true });
}
