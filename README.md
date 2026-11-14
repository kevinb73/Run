# Run Coach

Application iPhone (PWA) qui génère des plans d'entraînement course à pied personnalisés et adaptatifs,
sans abonnement. Données stockées localement sur le téléphone.

## Fonctionnalités (v0.1)

- **Questionnaire** : distance (5 km → marathon), date, objectif chrono, niveau, chrono de référence, volume actuel, jours disponibles.
- **Moteur de plan** (`app/js/engine/`) :
  - Allures calculées avec le modèle **VDOT** (Daniels) : endurance, marathon, seuil, VMA, vitesse, allure course.
  - **Périodisation** inversée depuis la date de course : Fondation → Développement → Spécifique → Affûtage.
  - Volume progressif (~+7 %/semaine), **semaine allégée toutes les 4 semaines**, sortie longue en rampe plafonnée selon la distance.
  - 1 à 2 séances de qualité/semaine selon le niveau, placées loin de la sortie longue.
  - Détection d'objectif irréaliste avec proposition d'un chrono atteignable.
- **Adaptation type coach** : retour après chaque séance (facile / correct / dur + km réels). Le bouton « Réajuster » recalcule les semaines à venir (allures, volume). Un nouveau chrono recalibre tout le plan.
- Séances décrites en **étapes structurées** (échauffement, répétitions, récupérations, allures cibles) : format prévu pour la conversion en séance Garmin.
- Fonctionne hors ligne, export/import de sauvegarde JSON.

## Installer sur iPhone

1. Le dépôt est publié via GitHub Pages (workflow `.github/workflows/pages.yml`, branche `main`).
   Une fois : *Settings → Pages → Source : GitHub Actions*.
2. Ouvrir l'URL Pages dans **Safari** → bouton Partager → **Sur l'écran d'accueil**.

## Développement

```bash
npm test          # tests du moteur (Node 22, aucune dépendance)
npm run serve     # http://localhost:8080
```

## Feuille de route

- [ ] **Garmin** : serveur Python (bibliothèque `garminconnect`) pour envoyer les séances sur la montre et récupérer les activités terminées.
- [ ] Rapprochement automatique activité Garmin ↔ séance prévue, adaptation à partir des données réelles (allure, FC).
- [ ] Zones cardiaques, gestion blessure / pause, plusieurs objectifs.
