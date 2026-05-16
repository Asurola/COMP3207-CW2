"""
COMP3207 Quiplash — Azure Functions (v2 Python model)
All 8 functions: player/register, player/login, player/update,
prompt/create, prompt/moderate, prompt/delete, utils/get, utils/welcome
"""
import os
import json
import logging
import azure.functions as func
import uuid
from shared_code.helpers import (
    get_cosmos_client,
    get_player_container,
    get_prompt_container,
    find_player_by_username,
    player_exists,
    translate_prompt_text,
    moderate_text,
    SUPPORTED_LANGUAGES,
)

app = func.FunctionApp()


# ---------------------------------------------------------------------------
# Helper: build a JSON HttpResponse
# ---------------------------------------------------------------------------
def json_response(data, status_code=200):
    """Return a properly serialized JSON HttpResponse."""
    return func.HttpResponse(
        body=json.dumps(data),
        mimetype="application/json",
        status_code=status_code,
    )


# ===========================================================================
# 1. /player/register — POST
# ===========================================================================
@app.function_name(name="player_register")
@app.route(route="player/register", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def player_register(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = body["username"]
        password = body["password"]

        # Validate username length (check FIRST)
        if len(username) < 5 or len(username) > 12:
            return json_response({"result": False, "msg": "Username less than 5 characters or more than 12 characters"})

        # Validate password length (check SECOND)
        if len(password) < 8 or len(password) > 12:
            return json_response({"result": False, "msg": "Password less than 8 characters or more than 12 characters"})

        # Check if username already exists (check THIRD)
        client = get_cosmos_client()
        container = get_player_container(client)

        if player_exists(container, username):
            return json_response({"result": False, "msg": "Username already exists"})

        # Create the player document — let Cosmos auto-generate the id
        player_doc = {
            "id": username,  # Use username as id since partition key is /id
            "username": username,
            "password": password,
            "games_played": 0,
            "total_score": 0,
        }
        container.create_item(body=player_doc)

        return json_response({"result": True, "msg": "OK"})

    except Exception as e:
        logging.error(f"player_register error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 2. /player/login — GET
# ===========================================================================
@app.function_name(name="player_login")
@app.route(route="player/login", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
def player_login(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = body["username"]
        password = body["password"]

        client = get_cosmos_client()
        container = get_player_container(client)

        player = find_player_by_username(container, username)

        if player is None or player["password"] != password:
            return json_response({"result": False, "msg": "Username or password incorrect"})

        return json_response({"result": True, "msg": "OK"})

    except Exception as e:
        logging.error(f"player_login error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 3. /player/update — PUT
# ===========================================================================
@app.function_name(name="player_update")
@app.route(route="player/update", methods=["PUT"], auth_level=func.AuthLevel.FUNCTION)
def player_update(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = body["username"]
        add_to_games_played = body["add_to_games_played"]
        add_to_score = body["add_to_score"]

        client = get_cosmos_client()
        container = get_player_container(client)

        player = find_player_by_username(container, username)
        if player is None:
            return json_response({"result": False, "msg": "Player does not exist"})

        # Update the fields
        player["games_played"] += add_to_games_played
        player["total_score"] += add_to_score

        # Replace the document in Cosmos DB
        container.replace_item(item=player["id"], body=player)

        return json_response({"result": True, "msg": "OK"})

    except Exception as e:
        logging.error(f"player_update error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 4. /prompt/create — POST
# ===========================================================================
@app.function_name(name="prompt_create")
@app.route(route="prompt/create", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def prompt_create(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        text = body["text"]
        username = body["username"]
        tags = body.get("tags", [])

        # Check player exists FIRST
        client = get_cosmos_client()
        player_container = get_player_container(client)

        if not player_exists(player_container, username):
            return json_response({"result": False, "msg": "Player does not exist"})

        # Validate prompt length SECOND
        if len(text) < 20 or len(text) > 120:
            return json_response({"result": False, "msg": "Prompt less than 20 characters or more than 120 characters"})

        # Translate (also detects language and checks confidence) THIRD
        texts, error = translate_prompt_text(text)
        if error:
            return json_response({"result": False, "msg": error})

        # Filter duplicate tags (case-insensitive)
        seen = set()
        unique_tags = []
        for tag in tags:
            lower = tag.lower()
            if lower not in seen:
                seen.add(lower)
                unique_tags.append(tag)

        # Store the prompt
        prompt_container = get_prompt_container(client)
        prompt_doc = {
            "id": str(uuid.uuid4()),
            "username": username,
            "texts": texts,
            "tags": unique_tags,
        }
        prompt_container.create_item(body=prompt_doc)

        return json_response({"result": True, "msg": "OK"})

    except Exception as e:
        logging.error(f"prompt_create error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 5. /prompt/moderate — POST
# ===========================================================================
@app.function_name(name="prompt_moderate")
@app.route(route="prompt/moderate", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def prompt_moderate(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        prompt_ids = body["prompt-ids"]

        client = get_cosmos_client()
        prompt_container = get_prompt_container(client)

        results = []
        for pid in prompt_ids:
            # Try to find the prompt — query cross-partition since we don't know the username
            query = "SELECT * FROM c WHERE c.id = @id"
            params = [{"name": "@id", "value": pid}]
            items = list(prompt_container.query_items(
                query=query, parameters=params, enable_cross_partition_query=True
            ))

            if not items:
                # Prompt doesn't exist — omit from output
                continue

            prompt_doc = items[0]

            # Find the English text
            english_text = None
            for t in prompt_doc["texts"]:
                if t["language"] == "en":
                    english_text = t["text"]
                    break

            if english_text is None:
                continue

            # Moderate the English text
            avg_severity, outcome = moderate_text(english_text)

            results.append({
                "prompt-id": pid,
                "outcome": outcome,
                "average_severity": avg_severity,
            })

        return json_response(results)

    except Exception as e:
        logging.error(f"prompt_moderate error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 6. /prompt/delete — POST
# ===========================================================================
@app.function_name(name="prompt_delete")
@app.route(route="prompt/delete", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def prompt_delete(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        player = body["player"]

        client = get_cosmos_client()
        prompt_container = get_prompt_container(client)

        # Find all prompts by this player
        query = "SELECT * FROM c WHERE c.username = @username"
        params = [{"name": "@username", "value": player}]
        items = list(prompt_container.query_items(
            query=query, parameters=params, enable_cross_partition_query=True
        ))

        count = 0
        for item in items:
            # Partition key is /username, so pass the username as partition key
            prompt_container.delete_item(item=item["id"], partition_key=player)
            count += 1

        return json_response({"result": True, "msg": f"{count} prompts deleted"})

    except Exception as e:
        logging.error(f"prompt_delete error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 7. /utils/get — GET
# ===========================================================================
@app.function_name(name="utils_get")
@app.route(route="utils/get", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
def utils_get(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        players = body["players"]
        tag_list = body["tag_list"]

        # Convert tag_list to lowercase for case-insensitive matching
        lower_tags = set(t.lower() for t in tag_list)

        client = get_cosmos_client()
        prompt_container = get_prompt_container(client)

        results = []
        for player_username in players:
            # Get all prompts by this player
            query = "SELECT * FROM c WHERE c.username = @username"
            params = [{"name": "@username", "value": player_username}]
            items = list(prompt_container.query_items(
                query=query, parameters=params, enable_cross_partition_query=True
            ))

            for item in items:
                # Check if at least one tag matches (case-insensitive)
                item_tags = set(t.lower() for t in item.get("tags", []))
                if item_tags & lower_tags:  # intersection — at least one match
                    results.append(item)

        return json_response(results)

    except Exception as e:
        logging.error(f"utils_get error: {e}")
        return json_response({"result": False, "msg": str(e)}, status_code=500)


# ===========================================================================
# 8. /utils/welcome — Cosmos DB Change Feed Trigger
# ===========================================================================
@app.function_name(name="utils_welcome")
@app.cosmos_db_trigger_v3(
    arg_name="documents",
    connection_string_setting="AzureCosmosDBConnectionString",
    database_name="quiplash",
    collection_name="player",
    lease_collection_name="leases",
    create_lease_collection_if_not_exists=True,
)
def utils_welcome(documents: func.DocumentList) -> None:
    """
    Cosmos DB change feed trigger — fires when documents are created or updated
    in the player container. We only create a welcome prompt for NEW players
    (i.e. games_played == 0 and total_score == 0, and no existing welcome prompt).
    """
    if not documents:
        return

    client = get_cosmos_client()
    prompt_container = get_prompt_container(client)

    for doc in documents:
        try:
            player = doc.to_dict() if hasattr(doc, "to_dict") else json.loads(doc.to_json())
        except Exception:
            player = doc

        username = player.get("username")
        if not username:
            continue

        # Only fire for newly registered players (games_played=0, total_score=0)
        if player.get("games_played", -1) != 0 or player.get("total_score", -1) != 0:
            continue

        # Double-check: skip if a welcome prompt already exists for this user
        query = "SELECT * FROM c WHERE c.username = @username AND STARTSWITH(c.texts[0].text, 'Welcome to COMP3207')"
        params = [{"name": "@username", "value": username}]
        existing = list(prompt_container.query_items(
            query=query, parameters=params, enable_cross_partition_query=True
        ))
        if existing:
            continue

        # Build the welcome text
        welcome_text = f"Welcome to COMP3207, {username}"

        # Translate just like /prompt/create
        texts, error = translate_prompt_text(welcome_text)
        if error:
            logging.warning(f"Could not translate welcome prompt for {username}: {error}")
            # Still store with just the original text
            texts = [{"language": "en", "text": welcome_text}]

        prompt_doc = {
            "id": str(uuid.uuid4()),
            "username": username,
            "texts": texts,
            "tags": [],
        }
        prompt_container.create_item(body=prompt_doc)
        logging.info(f"Created welcome prompt for player: {username}")
