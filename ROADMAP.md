# Feuille de route — Run Coach

_Dernière mise à jour : 14 novembre 2026 · app : **v0.16** (en attente de validation, PR #16) · serveur : **64abd20**_

Principe : **on n'ajoute une fonction que si elle sert la régularité, la progression ou la prévention des blessures.**
Les priorités sont revues après chaque bloc de 2–3 semaines de course réelle.

---

## Passation (à lire en premier dans une nouvelle session)

État au 14 novembre 2026, fin de la première session de développement :

- **App** : PWA dans `app/` (vanilla JS, aucune dépendance), publiée par GitHub Pages sur `kevinb73.github.io/Run/`. Version **v0.16** = nouvelle identité visuelle (style Nike Run Club : noir, volt `#d7ff1f`, Anton + Inter, icônes SVG `app/js/icons.js`, séance du jour en premier).
- **Serveur** : `server/` (FastAPI + garminconnect) sur Hetzner CPX02 Helsinki, `https://95-217-212-42.sslip.io` ; `/health` affiche la version du code ; mise à jour automatique horaire depuis `main` (ou redémarrage via l'API Hetzner). La clé d'accès du serveur n'est **pas** dans le dépôt : elle est saisie dans l'app (Profil) ; le jeton API Hetzner est un secret de l'environnement Claude « Run ».
- **Tests** : `npm test` (moteur, dont test de robustesse 600 profils) ; `python -m unittest server/test_server.py`.
- **Utilisateur** : coureur irrégulier qui reprend, futsal mercredi + dimanche (jours « course OU futsal »), arbitre (match le samedi), Forerunner 965, iPhone. Allure footing déclarée ~8'30–9'00/km ; sa base réelle (durée de course continue) est à confirmer après la séance du lundi 16 novembre → éventuellement repasser en mode « Reprendre la course » ou baisser l'allure.
- **Prochaines actions** : valider la v0.16 en main propre et ajuster le design écran par écran ; recalibrer le plan après les premières séances ; avant le 20 décembre : veille du test VMA allégée (3.1).

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
| 1.1 | ~~Atelier esthétique~~ → **fait en v0.16** (style Nike Run Club). Reste : ajustements après prise en main | L'app doit donner envie de l'ouvrir | Petit |
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

### 3.5 — Préparation au Yo-Yo test d'arbitre (priorité de la phase 3)

Objectif : réussir le **Yo-Yo test de début de saison (septembre 2027)**, quel que soit le mode choisi (remise en forme ou course).

| Élément | Détail |
|---|---|
| Option de profil | « Je suis arbitre » : date du test, variante du Yo-Yo test, palier requis pour la catégorie |
| Bloc spécifique | 8–10 semaines avant le test (≈ début juillet) : intermittent 15/15 et 30/30, navettes avec demi-tours, sprints répétés, affûtage la dernière semaine |
| Tests blancs | Toutes les 4–6 semaines, protocole + bande-son dans l'app, saisie du palier atteint |
| Estimation de réussite | Courbe des tests blancs vs palier requis, tendance et date estimée d'atteinte (mesure réelle plutôt que formule VMA → Yo-Yo, peu fiable pour ce profil) |
| Prérequis | **Circulaire CDA/CRA** : variante exacte (IR1 ou dynamique), palier requis pour ta catégorie, date du test |
| Calendrier | Construire au printemps 2027 ; bloc spécifique à partir de juillet 2027 |

Piste commerciale associée : niche « préparation physique des arbitres » (voir phase 6).

---

## Phase 4 — Confort et motivation

| # | Fonction | Commentaire | Effort |
|---|---|---|---|
| 4.1 | Rappel la veille (notification iPhone) | « Demain : footing 35 min » | Moyen |
| 4.2 | Prédiction 10 km dans Progrès | Quand la sortie longue dépasse 10–12 km | Petit |
| 4.3 | Suivi des chaussures (km par paire) | Changer avant usure | Petit |
| 4.4 | Ajustement chaleur (> 25 °C) | Utile à partir du printemps | Petit |

---

## Phase 6 — Exploration commerciale (à décider après 2–3 mois d'usage)

| Étape | Critère de passage |
|---|---|
| 6.1 Usage perso régulier pendant 2–3 mois | Tu l'utilises vraiment chaque semaine |
| 6.2 Bêta gratuite : 5–10 personnes (futsal, arbitres) | ≥ 50 % l'utilisent encore après 1 mois, plusieurs demandent à continuer |
| 6.3 Étude : API Garmin officielle (programme développeur), RGPD données de santé, statut juridique, prix (≈ 5–10 €/mois) | Accès Garmin officiel obtenu |
| 6.4 Refonte multi-utilisateurs (comptes, base de données, paiement) | — |

Niche la plus prometteuse : **préparation physique des arbitres** (tests obligatoires, réseau structuré, peu de solutions dédiées).

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
| v0.16 | Nouvelle identité visuelle (noir / volt, Anton + Inter, icônes dessinées, séance du jour en premier) |

## Coûts récurrents

| Poste | Coût |
|---|---|
| Serveur Hetzner (CPX02, Helsinki, IPv4 incluse) | ~7,91 € / mois TTC |
| GitHub, hébergement de l'app | 0 € |
| Coach ChatGPT (phase 2) | 0 € (abonnement existant) |
