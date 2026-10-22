import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.languagetool.JLanguageTool;
import org.languagetool.Language;
import org.languagetool.Languages;
import org.languagetool.rules.RuleMatch;
import org.languagetool.rules.spelling.SpellingCheckRule;
import org.languagetool.language.identifier.detector.FastTextDetector;

public final class LanguageToolWorker {
    private static final Map<String, JLanguageTool> TOOLS = new HashMap<>();
    private static final Map<String, Optional<SpellingCheckRule>> SPELLERS = new HashMap<>();
    private static FastTextDetector detector;
    private static String autoDetectError;

    private static JLanguageTool toolFor(String code) {
        return TOOLS.computeIfAbsent(code, key -> {
            Language language = Languages.getLanguageForShortCode(key);
            if (language == null) throw new IllegalArgumentException("Unknown language: " + key);
            // Bare codes such as "en" (from fastText or the settings list) have no spell checker; only variants do.
            Language variant = language.getDefaultLanguageVariant();
            return new JLanguageTool(variant != null ? variant : language);
        });
    }

    private static Optional<SpellingCheckRule> spellerFor(String code) {
        return SPELLERS.computeIfAbsent(code, key -> toolFor(key).getAllActiveRules().stream()
            .filter(rule -> rule instanceof SpellingCheckRule speller && speller.isDictionaryBasedSpellingRule())
            .map(rule -> (SpellingCheckRule) rule)
            .findFirst());
    }

    /** A spelling error is not an error if another selected language knows the word. */
    private static boolean knownInOtherLanguage(String word, String code, List<String> codes) {
        for (String other : codes) {
            if (other.equals(code)) continue;
            Optional<SpellingCheckRule> speller = spellerFor(other);
            try {
                if (speller.isPresent() && !speller.get().isMisspelled(word)) return true;
            } catch (IOException error) {
                // Treat an unreadable dictionary as "unknown word" so the match stays visible.
            }
        }
        return false;
    }

    private static String resolveLanguage(String text, String code) throws Exception {
        if (!"auto".equals(code)) return code;
        if (detector == null) throw new IllegalStateException("Auto-detect is unavailable: " + autoDetectError + " Choose explicit languages in the LanguageTool extension settings to keep checking.");
        Map<String, Double> scores = detector.runFasttext(text, Collections.emptyList());
        return scores.entrySet().stream().max(Map.Entry.comparingByValue()).orElseThrow().getKey();
    }

    private static JSONArray check(String text, List<String> codes) throws Exception {
        JSONArray matches = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (String code : codes) {
            for (RuleMatch match : toolFor(code).check(text)) {
                boolean spelling = match.getRule().isDictionaryBasedSpellingRule();
                if (spelling && codes.size() > 1 && knownInOtherLanguage(text.substring(match.getFromPos(), match.getToPos()), code, codes)) continue;
                String key = match.getFromPos() + ":" + match.getToPos() + ":" + (spelling ? "misspelling" : "grammar");
                if (!seen.add(key)) continue;
                JSONObject rule = new JSONObject();
                rule.put("id", match.getRule().getId());
                rule.put("issueType", spelling ? "misspelling" : "grammar");
                JSONArray replacements = new JSONArray();
                for (String replacement : match.getSuggestedReplacements()) replacements.put(new JSONObject().put("value", replacement));
                matches.put(new JSONObject()
                    .put("message", plainMessage(match.getMessage()))
                    .put("shortMessage", plainMessage(match.getShortMessage()))
                    .put("offset", match.getFromPos())
                    .put("length", match.getToPos() - match.getFromPos())
                    .put("replacements", replacements)
                    .put("rule", rule));
            }
        }
        return matches;
    }

    /** LanguageTool marks suggestions as <suggestion>x</suggestion>; clients show plain text. */
    private static String plainMessage(String message) {
        return message == null ? "" : message.replace("<suggestion>", "“").replace("</suggestion>", "”");
    }

    private static String shorten(String message) {
        String text = message == null ? "" : message.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
        return text.length() > 200 ? text.substring(0, 200) : text;
    }

    private static void initDetector(File model, File binary) {
        if (!model.isFile() || model.length() < 1_000_000) {
            autoDetectError = "Language model " + model.getName() + " is missing or is a Git LFS pointer (" + model.length() + " bytes). Run 'git lfs install --local' and then 'git lfs pull' in the plugin folder, then restart SillyTavern.";
            return;
        }
        try {
            detector = new FastTextDetector(model, binary);
            detector.runFasttext("This is a short test sentence.", Collections.emptyList());
        } catch (Exception e) {
            detector = null;
            String detail = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            autoDetectError = "fastText language detection failed: " + shorten(detail);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Expected fastText model and binary paths");
        initDetector(new File(args[0]), new File(args[1]));
        JSONObject ready = new JSONObject().put("ready", true).put("autoDetect", detector != null);
        if (autoDetectError != null) ready.put("autoDetectError", autoDetectError);
        System.out.println(ready);
        System.out.flush();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                JSONObject request = new JSONObject(line);
                JSONObject response = new JSONObject().put("id", request.getString("id"));
                try {
                    String text = request.getString("text");
                    JSONArray languages = request.getJSONArray("languages");
                    LinkedHashSet<String> codes = new LinkedHashSet<>();
                    for (int i = 0; i < languages.length(); i++) codes.add(resolveLanguage(text, languages.getString(i)));
                    response.put("matches", check(text, new ArrayList<>(codes)));
                } catch (Exception error) {
                    response.put("error", error.getMessage());
                }
                System.out.println(response);
                System.out.flush();
            }
        }
    }
}
