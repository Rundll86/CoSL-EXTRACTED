import l10nJson from "./l10n.json" with {type: "json"};
import assetsJson from "./assets.json" with {type: "json"};
import fs from "fs/promises";
import jsonbig from "json-bigint";
import path from "path";
import process from "process";
import { program } from "commander";

program
    .option("-r, --read", null, false)
    .option("-f, --file <filename>", null, "graphs/entry_stage.json");
program.parse();
const opts = program.opts();

const SPECIAL_FIELDS = {};
const mainJson = jsonbig({ storeAsString: true }).parse(await fs.readFile(opts.file, "utf8"));
const assetByKey = new Map(assetsJson.map(asset => [`${asset.type}:${asset.path_id}`, asset]));
const objectCache = new Map();
function pointerId(pointer) {
    return pointer?.m_PathID ?? pointer?.path_id;
}
function findAsset(pathId, type = "Sprite") {
    if (pathId === undefined || pathId === null || String(pathId) === "0") return undefined;
    return assetByKey.get(`${type}:${String(pathId)}`);
}
function getAssetPlainName(pathId, type = "Sprite") {
    const asset = findAsset(pathId, type);
    return asset?.relative_path
        ? path.basename(asset.relative_path, path.extname(asset.relative_path))
        : undefined;
}
async function readExportedObject(pathId, type = "MonoBehaviour") {
    const asset = findAsset(pathId, type);
    if (!asset?.relative_path) return undefined;
    if (!objectCache.has(asset.relative_path)) {
        objectCache.set(
            asset.relative_path,
            jsonbig({ storeAsString: true }).parse(await fs.readFile(asset.relative_path, "utf8"))
        );
    }
    return objectCache.get(asset.relative_path);
}
function spriteName(asset) {
    return asset?.relative_path
        ? path.basename(asset.relative_path, path.extname(asset.relative_path))
        : undefined;
}
async function resolveAvatarReference(ref) {
    if (!ref) return undefined;
    const direct = getAssetPlainName(pointerId(ref), "Sprite");
    if (direct) return direct;
    const avatar = await readExportedObject(pointerId(ref), "MonoBehaviour");
    if (!avatar) return undefined;
    for (const key of ["Sprite", "Normal", "Wink", "Dumbness", "DumbnessWink"]) {
        const resolved = getAssetPlainName(pointerId(avatar[key]), "Sprite");
        if (resolved) return resolved;
    }
    return undefined;
}
async function resolveExplicitAvatar(refData) {
    if (!refData?.Enabled) return undefined;
    return await resolveAvatarReference(refData.Sprite)
        ?? await resolveAvatarReference(refData.QlcAvatar);
}
const characterById = new Map();
const characterByNameId = new Map();
const characterByPathId = new Map();
for (const asset of assetsJson.filter(a => a.type === "MonoBehaviour" && /_character\.bundle$/i.test(a.bundle))) {
    const object = await readExportedObject(asset.path_id, "MonoBehaviour");
    if (object?.Id !== undefined) characterById.set(String(object.Id), object);
    if (object?.NameId !== undefined) characterByNameId.set(String(object.NameId), object);
    characterByPathId.set(String(asset.path_id), object);
}
const avatarPrefixByCharacterName = new Map([
    ["QianLucai", "QLC"], ["YanLiaoliao", "YLL"], ["LuoLuoai", "LLA"],
    ["JiangBolao", "JBL"], ["JiYe", "JY"], ["HongZhenli", "HZL"],
    ["LuoMiujia", "LMJ"], ["QianSanyuan", "QSY"], ["QiuLian", "QL"]
]);
const dialogueAvatarAssets = assetsJson.filter(a =>
    a.type === "MonoBehaviour" && /^DA_/i.test(a.name)
);
const avatarByCharacterId = new Map();
for (const asset of dialogueAvatarAssets) {
    const object = await readExportedObject(asset.path_id, "MonoBehaviour");
    if (object?.Character_Id !== undefined) {
        if (!avatarByCharacterId.has(String(object.Character_Id))) avatarByCharacterId.set(String(object.Character_Id), []);
        avatarByCharacterId.get(String(object.Character_Id)).push(object);
    }
}
function avatarCandidates(characterId, type = 1) {
    const all = avatarByCharacterId.get(String(characterId)) ?? [];
    const marker = Number(type) === 1 ? "_A_" : "_H_";
    return all.filter(a => a.m_Name?.includes(marker)).concat(all.filter(a => !a.m_Name?.includes(marker)));
}
async function resolveCharacterAvatar(characterId, type = 1) {
    if (characterId === undefined || characterId === null) return undefined;
    for (const avatar of avatarCandidates(characterId, type)) {
        const sprite = await resolveAvatarReference(avatar.Normal)
            ?? await resolveAvatarReference(avatar.Wink);
        if (sprite) return sprite;
    }
    const character = characterById.get(String(characterId));
    const embedded = await resolveAvatarReference(character?.Avatar)
        ?? await resolveAvatarReference(character?.avatar);
    if (embedded) return embedded;
    const prefix = avatarPrefixByCharacterName.get(character?.m_Name);
    if (!prefix) return undefined;
    const candidates = assetsJson.filter(asset =>
        asset.type === "Sprite" && asset.name.startsWith(`DialogueAvatar_${prefix}`)
    );
    const mode = Number(type) === 1 ? "_A_" : "_H_";
    const preferred = candidates.find(a => a.name.includes(mode) && /_(Usual|Costume)$/.test(a.name))
        ?? candidates.find(a => a.name.includes(mode) && !/Black|Wink|Dumbness/.test(a.name))
        ?? candidates.find(a => /_H_Usual$/.test(a.name))
        ?? candidates.find(a => !/Black|Wink|Dumbness/.test(a.name))
        ?? candidates[0];
    return spriteName(preferred);
}
const { Chs: l10n } = l10nJson;
const { actions } = mainJson.screenplays[0];
const avatarBindings = new Map();
const historyAvatars = new Map();
const currentAvatarBySpeaker = new Map();
let selfSpeakerCharacterId = undefined;
const result = [];
function speakerKey(speaker) {
    if (!speaker) return undefined;
    if (speaker.reference_character) return `character:${String(pointerId(speaker.character))}`;
    return `name:${String(speaker.speaker_name_id ?? "")}`;
}
for (const action of actions) {
    if (!action.active) continue;
    const payload = action.payload ?? {};
    if (action.type === "AvatarBindAction") {
        const nameId = String(payload.NameId ?? "");
        if (Number(payload.Operation) === 0) avatarBindings.set(nameId, payload.CharacterId);
        else if (Number(payload.Operation) === 1) avatarBindings.delete(nameId);
    }
    if (action.type === "HistoryAvatarAction") {
        const characterId = String(payload.CharacterId ?? "");
        if (Number(payload.Operation) === 0) historyAvatars.set(characterId, await resolveAvatarReference(payload.Avatar));
        else if (Number(payload.Operation) === 1) historyAvatars.delete(characterId);
        if (payload.SelfSpeakerCharacterId !== undefined && payload.SelfSpeakerCharacterId !== null && String(payload.SelfSpeakerCharacterId) !== "0") {
            selfSpeakerCharacterId = payload.SelfSpeakerCharacterId;
        }
    }
    const refData = action.dialogue?.AvatarRefData;
    const speakerCharacter = characterByPathId.get(String(pointerId(action.speaker?.character)))
        ?? characterByNameId.get(String(action.speaker?.speaker_name_id ?? ""));
    const speakerNameId = action.speaker?.reference_character
        ? speakerCharacter?.NameId
        : action.speaker?.speaker_name_id;
    const sayer = l10n[speakerNameId]?.replace(/<\/?[^>]+>/g, '')
        ?? speakerCharacter?.Name?.replace(/<\/?[^>]+>/g, '');
    let sprite;
    if (action.type === "DialogueAction") {
        const key = speakerKey(action.speaker);
        sprite = await resolveExplicitAvatar(refData);
        if (sprite && key) currentAvatarBySpeaker.set(key, sprite);
        sprite ??= key ? currentAvatarBySpeaker.get(key) : undefined;
        const nameId = String(action.speaker?.speaker_name_id ?? "");
        const characterObject = speakerCharacter;
        const boundCharacterId = avatarBindings.get(nameId);
        let characterId = boundCharacterId ?? characterObject?.Id;
        if (characterId === undefined && selfSpeakerCharacterId !== undefined && sayer === "我") {
            characterId = selfSpeakerCharacterId;
        }
        sprite ??= historyAvatars.get(String(characterId));
        sprite ??= await resolveCharacterAvatar(characterId, refData?.Type);
        if (sprite && key) currentAvatarBySpeaker.set(key, sprite);
    }
    const centerDisplay = Boolean(action.dialogue?.DisplayMode);
    const output = {
        type: action.type,
        text: l10n[action.language_id]?.replace(/<\/?[^>]+>/g, ''),
        sayer,
        order: action.order,
        background: getAssetPlainName(pointerId(action.payload?.BackgroundSprite)),
        pause: action.payload?.PauseDuration,
        center: centerDisplay,
        ...(SPECIAL_FIELDS[action.path_id] ?? {})
    };
    if (action.type === "DialogueAction") {
        const hasSpeaker = Boolean(sayer || action.speaker?.reference_character);
        if (hasSpeaker) output.sprite = sprite ?? null;
    }
    result.push(output);
}
await fs.writeFile("output.json", JSON.stringify(result, null, 4), "utf8");
await fs.writeFile("tree.txt", result.filter(e => [
    "DialogueAction",
    "BackgroundAction",
    "PauseAction",
    "StorylineFlagAction",
    "CinemachineImpulseAction"
].includes(e.type) || e.type.startsWith("CharacterAction_")).map(e => JSON.stringify(e).replaceAll(",", "<UNCENSORED>")).join("\n"), "utf8");
if (opts.read) {
    console.log(
        result.map(e => {
            if (e.type === "DialogueAction") {
                return e.sayer ? `${e.sayer}：${e.text.replaceAll("\n", "\n  ")}` : `\n${e.text}\n`;
            } else {
                return null;
            }
        }).filter(Boolean).join("\n")
    );
}
