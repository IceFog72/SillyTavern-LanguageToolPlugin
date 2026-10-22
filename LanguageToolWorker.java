import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.languagetool.JLanguageTool;
import org.languagetool.Language;
import org.languagetool.Languages;
import org.languagetool.rules.RuleMatch;
import org.languagetool.language.identifier.detector.FastTextDetector;

public final class LanguageToolWorker {
    private static final Map<String, JLanguageTool> TOOLS = new HashMap<>();
    private static FastTextDetector detector;
    private static String autoDetectError;

    private static JLanguageTool toolFor(String code) {
        return TOOLS.computeIfAbsent(code, key -> {
            Language language = Languages.getLanguageForShortCode(key);
            if (language == null) throw new IllegalArgumentException("Unknown language: " + key);
            return new JLanguageTool(language);
        });
    }

    private static JSONArray check(String text, String code) throws Exception {
        if ("auto".equals(code)) {
            if (detector == null) throw new IllegalStateException("Auto-detect is unavailable: " + autoDetectError + " Choose explicit languages in the LanguageTool extension settings to keep checking.");
            Map<String, Double> scores = detector.runFasttext(text, Collections.emptyList());
            code = scores.entrySet().stream().max(Map.Entry.comparingByValue()).orElseThrow().getKey();
        }
        JSONArray matches = new JSONArray();
        for (RuleMatch match : toolFor(code).check(text)) {
            JSONObject rule = new JSONObject();
            rule.put("id", match.getRule().getId());
            rule.put("issueType", match.getRule().isDictionaryBasedSpellingRule() ? "misspelling" : "grammar");
            JSONArray replacements = new JSONArray();
            for (String replacement : match.getSuggestedReplacements()) replacements.put(new JSONObject().put("value", replacement));
            matches.put(new JSONObject()
                .put("message", match.getMessage())
                .put("shortMessage", match.getShortMessage())
                .put("offset", match.getFromPos())
                .put("length", match.getToPos() - match.getFromPos())
                .put("replacements", replacements)
                .put("rule", rule));
        }
        return matches;
    }

    private static String shorten(String message) {
        String text = message == null ? "" : message.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
        return text.length() > 200 ? text.substring(0, 200) : text;
    }

    private static void initDetector(File model, File binary) {
        if (!model.isFile() || model.length() < 1_000_000) {
            autoDetectError = "Language model " + model.getName() + " is missing or is a Git LFS pointer (" + model.length() + " bytes). Run 'git lfs pull' in the plugin folder, then restart SillyTavern.";
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
                    JSONArray matches = new JSONArray();
                    JSONArray languages = request.getJSONArray("languages");
                    for (int i = 0; i < languages.length(); i++) matches.putAll(check(request.getString("text"), languages.getString(i)));
                    response.put("matches", matches);
                } catch (Exception error) {
                    response.put("error", error.getMessage());
                }
                System.out.println(response);
                System.out.flush();
            }
        }
    }
}
