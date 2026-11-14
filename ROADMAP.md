# Feuille de route — Run Coach

_Dernière mise à jour : 14 novembre 2026 · version en ligne : **v0.15**_

Principe : **on n'ajoute une fonction que si elle sert la régularité, la progression ou la prévention des blessures.**
Les priorités sont revues après chaque bloc de 2–3 semaines de course réelle.

---

## Phase 0 — Validation sur le terrain (maintenant → ~5 décembre)

Objectif : vérifier sur données réelles ce qui a été testé sur données simulées.

| # | Point à valider | Comment | Statut |
|---|---|---|---|
| 0.1 | Calibrage du plan (durée de course continue, allure footing) | Séance du lundi 16 : noter le moment où la marche devient nécessaire, puis ajuster mode / allure | ⏳ |
| 0.2 | Import Garmin réel (séance cochée, données, ressenti) | Après chaque course | ⏳ |
| 0.3 | Récap de séance et analyse sur vraies données | Après chaque course | ⏳ |
| 0.4 | Forme du jour (VFC, sommeil) | Porter la montre la nuit ; VFC fiable après ~3 semaines | ⏳ |
| 0.5 | Charge d'entraînement (futsal compris) | Ratio fiable après 2 semaines de données | ⏳ |
| 0.6 | Premier bilan du lundi | Lundi 23 / 30 novembre | ⏳ |

Livrable : liste des corrections et des seuils à ajuster.

---

## Phase 1 — Esthétique et confort d'usage (à discuter dans les prochains jours)

| # | Fonction | Pourquoi | Effort |
|---|---|---|---|
| 1.1 | **Atelier esthétique** : couleurs, typographie, icônes, écran d'accueil | L'app doit donner envie de l'ouvrir | Moyen |
| 1.2 | Icône d'app et écran de démarrage soignés | Première impression sur l'iPhone | Petit |
| 1.3 | Retirer de la montre une séance faite en avance | Aujourd'hui elle reste affichée à sa date d'origine | Petit |

Entrée attendue : tes captures annotées de ce qui te gêne visuellement.

---

## Phase 2 — Coach conversationnel avec ChatGPT (après ~3 semaines de course)

Les GPT personnalisés sont retirés par OpenAI le **11 décembre 2026** : on passe par un **serveur MCP**.

| # | Fonction | Détail | Effort |
|---|---|---|---|
| 2.1 | Serveur MCP sur le serveur Hetzner (lecture seule) | Plan, dernières séances + analyses, douleurs, charge, forme du jour, prédictions | 1–2 h |
| 2.2 | Branchement dans ChatGPT Plus | Plugins → « Add custom MCP server » (≈ 10 min de ton côté) | Petit |
| 2.3 | Actions (mettre en pause, alléger une séance) | Seulement si l'écriture est disponible sur l'offre Plus | À confirmer |

Coût : 0 € (abonnement ChatGPT existant). Points d'attention : confidentialité (données de santé lues par OpenAI), menus ChatGPT qui évoluent vite — revérifier la documentation officielle au moment de construire.

---

## Phase 3 — Prévention et souplesse du plan

| # | Fonction | Pourquoi | Effort |
|---|---|---|---|
| 3.1 | **Veille du test VMA allégée automatiquement** | Test du 28 décembre fiable (pas de futsal / sortie longue la veille) | Petit — **avant le 20 déc.** |
| 3.2 | **Modifier ses jours sans refaire le plan** | Planning futsal / arbitrage variable ; garder l'historique | Moyen |
| 3.3 | **Renforcement & mobilité** (2 × 15 min / sem.) envoyés sur la montre | Chevilles, genoux, tendons : le risque n° 1 avec le futsal | Moyen |
| 3.4 | Indisponibilités ponctuelles (« pas dispo jeudi ») | Redistribuer la semaine | Petit |

---

## Phase 4 — Confort et motivation

| # | Fonction | Commentaire | Effort |
|---|---|---|---|
| 4.1 | Rappel la veille (notification iPhone) | « Demain : footing 35 min » | Moyen |
| 4.2 | Prédiction 10 km dans Progrès | Quand la sortie longue dépasse 10–12 km | Petit |
| 4.3 | Suivi des chaussures (km par paire) | Changer avant usure | Petit |
| 4.4 | Ajustement chaleur (> 25 °C) | Utile à partir du printemps | Petit |

---

## Phase 5 — Plus tard / à arbitrer

- Préparation de course avec objectifs intermédiaires (ex. 5 km test avant un 10 km).
- Partage du récap (image) vers les réseaux / un ami.
- Mode multi-sports avancé (vélo, natation) si besoin.

---

## Déjà livré

| Version | Contenu |
|---|---|
| v0.1–v0.4 | App iPhone (PWA), questionnaire, plans course & remise en forme, futsal / arbitrage, jour « course OU sport » |
| v0.5–v0.6 | Allures calibrées sur le footing, « Faire cette séance aujourd'hui » |
| v0.7–v0.9 | Serveur Hetzner, Garmin : envoi automatique des séances, import des courses, sauvegarde serveur, coach sur FC/allure |
| v0.10 | Test VMA 6 min (recalibrage plafonné) |
| v0.11–v0.12 | Analyse de chaque séance, forme du jour, charge aiguë/chronique, rattrapage, écran Progrès |
| v0.13 | Récap de séance (calories, prévu/réalisé, étapes, mot du coach) |
| v0.14 | Corrections avant la 1re séance (course antérieure au plan, alerte « trop lent », refaire le plan) |
| v0.15 | Douleur (conseils de prudence), pause (maladie / blessure / vacances), test de robustesse |

## Coûts récurrents

| Poste | Coût |
|---|---|
| Serveur Hetzner (CPX02, Helsinki, IPv4 incluse) | ~7,91 € / mois TTC |
| GitHub, hébergement de l'app | 0 € |
| Coach ChatGPT (phase 2) | 0 € (abonnement existant) |
