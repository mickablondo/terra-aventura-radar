"""
Nettoyage de l'export CSV Terra Aventura issu de DATAtourisme.

Corrige trois problèmes typiques de cet export :
1. Encodage mal interprété (UTF-8 lu comme Latin-1 -> "Ã¨" au lieu de "è")
2. En-tête avec une colonne "Sous-type" dupliquée
3. Circuits comptés deux fois (une fiche "Produit" + une fiche "Lieu" séparées)

Usage :
    python clean_terra_aventura.py mon_export.csv
"""

import csv
import json
import re
import sys
from pathlib import Path


def fix_mojibake(text: str) -> str:
    """Répare un texte UTF-8 mal réinterprété en Latin-1 (ex: 'Ã¨' -> 'è')."""
    if not text:
        return text
    try:
        return text.encode("latin1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


def dedupe_header(header: list[str]) -> list[str]:
    """Renomme les colonnes en double (ex: deux 'Sous-type') pour ne pas en perdre."""
    counts: dict[str, int] = {}
    result = []
    for name in header:
        counts[name] = counts.get(name, 0) + 1
        result.append(name if counts[name] == 1 else f"{name}_{counts[name]}")
    return result


def normalize_name(name: str) -> str:
    """Nom simplifié utilisé pour repérer les doublons Produit/Lieu du même circuit."""
    name = name.lower()
    name = re.sub(r"[^a-z0-9]+", " ", name)
    return name.strip()


def is_terra_aventura(name: str) -> bool:
    """Vérifie que le nom contient bien la phrase "Terra Aventura" (ou "Tèrra
    Aventura", "Térra Aventura"...), et pas seulement l'un des deux mots pris
    isolément (ex: "Terra Pin", "Café Terra", "L'Avventura")."""
    return bool(re.search(r"t[eèé]rra\s*-?\s*aventura", name, re.IGNORECASE))


def filter_terra_aventura(rows: list[dict]) -> list[dict]:
    """Ne garde que les lignes dont le nom correspond réellement à un parcours
    Terra Aventura (le filtre de recherche DATAtourisme fait du texte libre
    et remonte des faux positifs comme "Terra Pin" ou "L'Avventura")."""
    kept, removed = [], []
    for row in rows:
        if is_terra_aventura(row.get("Nom", "")):
            kept.append(row)
        else:
            removed.append(row.get("Nom", ""))

    if removed:
        print(f"  {len(removed)} lignes retirées car le nom ne correspond pas "
              f"à \"Terra/Tèrra Aventura\", ex: {removed[:5]}")

    return kept


def load_rows(path: str):
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = dedupe_header([fix_mojibake(h) for h in next(reader)])
        for values in reader:
            if not values:
                continue
            values = [fix_mojibake(v) for v in values]
            # Ligne plus courte/longue que l'en-tête -> probable ligne malformée, on l'ignore
            if len(values) != len(header):
                print(f"  ligne ignorée (colonnes incohérentes) : {values[:2]}")
                continue
            yield dict(zip(header, values))


def dedupe_circuits(rows: list[dict]) -> list[dict]:
    """Garde une seule fiche par circuit, en préférant le type 'Produit' quand
    le même circuit (même nom normalisé + même commune) apparaît plusieurs fois."""
    seen: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (normalize_name(row.get("Nom", "")), row.get("Commune", ""))
        current_type = row.get("Type", "")

        if key not in seen:
            seen[key] = row
            continue

        existing_type = seen[key].get("Type", "")
        if "Produit" in current_type and "Produit" not in existing_type:
            seen[key] = row  # on préfère la fiche "Produit" à la fiche "Lieu" seule

    return list(seen.values())


def to_geojson(rows: list[dict]) -> dict:
    features = []
    skipped = 0
    for row in rows:
        try:
            lat = float(row["Latitude"])
            lon = float(row["Longitude"])
        except (ValueError, KeyError):
            skipped += 1
            continue

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "nom": row.get("Nom"),
                "identifiant": row.get("Identifiant"),
                "type": row.get("Type"),
                "commune": row.get("Commune"),
                "code_postal": row.get("Code postal"),
                "departement": row.get("Département"),
                "region": row.get("Région"),
                "site_internet": row.get("Site internet"),
                "createur": row.get("Créateur"),
            },
        })

    if skipped:
        print(f"  {skipped} lignes sans coordonnées valides, ignorées")

    return {"type": "FeatureCollection", "features": features}


def main():
    if len(sys.argv) != 2:
        print("Usage : python clean_terra_aventura.py mon_export.csv")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = Path(input_path).with_suffix(".geojson")

    rows = list(load_rows(input_path))
    print(f"{len(rows)} lignes lues depuis {input_path}")

    ta_rows = filter_terra_aventura(rows)
    print(f"{len(ta_rows)} lignes correspondant réellement à Terra Aventura")

    unique_rows = dedupe_circuits(ta_rows)
    print(f"{len(unique_rows)} circuits uniques après déduplication "
          f"({len(ta_rows) - len(unique_rows)} doublons Produit/Lieu retirés)")

    geojson = to_geojson(unique_rows)
    output_path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Export terminé : {output_path} ({len(geojson['features'])} points)")


if __name__ == "__main__":
    main()
