"""
Shared helper functions for Cosmos DB, Azure Translation, and Content Safety.
"""
import os
import json
import requests
import uuid
from azure.cosmos import CosmosClient, exceptions


# ---------------------------------------------------------------------------
# Cosmos DB helpers
# ---------------------------------------------------------------------------

def get_cosmos_client():
    """Return a CosmosClient using the connection string from env."""
    conn_str = os.environ["AzureCosmosDBConnectionString"]
    return CosmosClient.from_connection_string(conn_str)


def get_database(client):
    db_name = os.environ.get("DatabaseName", "quiplash")
    return client.get_database_client(db_name)


def get_player_container(client):
    db = get_database(client)
    container_name = os.environ.get("PlayerContainerName", "player")
    return db.get_container_client(container_name)


def get_prompt_container(client):
    db = get_database(client)
    container_name = os.environ.get("PromptContainerName", "prompt")
    return db.get_container_client(container_name)


def find_player_by_username(container, username):
    """Query for a player by username. Returns the player dict or None."""
    query = "SELECT * FROM c WHERE c.username = @username"
    params = [{"name": "@username", "value": username}]
    items = list(container.query_items(query=query, parameters=params, enable_cross_partition_query=True))
    return items[0] if items else None


def player_exists(container, username):
    """Check if a player with the given username exists."""
    return find_player_by_username(container, username) is not None


# ---------------------------------------------------------------------------
# Azure Translation helpers
# ---------------------------------------------------------------------------

SUPPORTED_LANGUAGES = ["en", "cy", "es", "ta", "zh-Hans", "ar"]


def detect_language(text):
    """
    Detect the language of the input text using Azure Translator.
    Returns (language_code, confidence) tuple.
    """
    endpoint = os.environ["TranslationEndpoint"]
    key = os.environ["TranslationKey"]

    # The detect endpoint
    url = endpoint.rstrip("/") + "/detect?api-version=3.0"
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
    }
    body = [{"text": text}]
    response = requests.post(url, headers=headers, json=body)
    response.raise_for_status()
    result = response.json()
    return result[0]["language"], result[0]["score"]


def translate_text(text, from_lang, to_languages):
    """
    Translate text from from_lang to a list of target languages.
    Returns a dict mapping language code -> translated text.
    """
    endpoint = os.environ["TranslationEndpoint"]
    key = os.environ["TranslationKey"]

    # Build the 'to' query params
    to_params = "&".join([f"to={lang}" for lang in to_languages])
    url = f"{endpoint.rstrip('/')}/translate?api-version=3.0&from={from_lang}&{to_params}&textType=plain"

    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
    }
    body = [{"text": text}]
    response = requests.post(url, headers=headers, json=body)
    response.raise_for_status()
    result = response.json()

    translations = {}
    for t in result[0]["translations"]:
        translations[t["to"]] = t["text"]
    return translations


def translate_prompt_text(text):
    """
    Full pipeline: detect language, check confidence, translate to all 6 languages.
    Returns (texts_array, error_msg) where error_msg is None on success.
    """
    # Detect language
    detected_lang, confidence = detect_language(text)

    if confidence < 0.2:
        return None, "Unsupported language"

    # Determine which languages we need to translate TO (exclude the detected language)
    target_languages = [lang for lang in SUPPORTED_LANGUAGES if lang != detected_lang]

    # Translate
    translations = translate_text(text, detected_lang, target_languages)

    # Build the texts array: original text stored as-is under its detected language
    texts = [{"language": detected_lang, "text": text}]
    for lang in target_languages:
        texts.append({"language": lang, "text": translations[lang]})

    return texts, None


# ---------------------------------------------------------------------------
# Azure Content Safety helpers
# ---------------------------------------------------------------------------

def moderate_text(text):
    """
    Moderate text using Azure Content Safety API.
    Returns (average_severity, outcome) tuple.
    average_severity = average of severity scores across all 4 categories.
    outcome = True if average_severity > 2, else False.
    """
    endpoint = os.environ["ContentSafetyEndpoint"]
    key = os.environ["ContentSafetyKey"]

    url = f"{endpoint.rstrip('/')}/contentsafety/text:analyze?api-version=2023-10-01"
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
    }
    body = {"text": text}
    response = requests.post(url, headers=headers, json=body)
    response.raise_for_status()
    result = response.json()

    # Sum severity scores from all 4 categories
    categories = result.get("categoriesAnalysis", [])
    total_severity = sum(cat["severity"] for cat in categories)
    avg = total_severity / len(categories) if categories else 0

    # Round to avoid floating point weirdness (spec shows 2 decimal places)
    avg = round(avg, 2)
    outcome = avg > 2

    return avg, outcome
