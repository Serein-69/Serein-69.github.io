using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Crab1v1Server
{
    public static class WebLeaderboardService
    {
        private static readonly HashSet<ulong> HardcodedAuthorizedHosts = new HashSet<ulong>()
        {
            76561198774892555,
            76561199115475689,
            76561199793198788,
        };

        public static bool IsAuthorizedHost(ulong hostId)
        {
            if (HardcodedAuthorizedHosts.Count == 0) return true;
            return HardcodedAuthorizedHosts.Contains(hostId);
        }

        private static string GenerateSignature(string payload, long timestamp, ulong hostId)
        {
            string raw = $"{payload}:{timestamp}:{hostId}:{Configuration.WebApiSecretKey}";
            using var sha256 = SHA256.Create();
            byte[] hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(raw));
            StringBuilder sb = new StringBuilder();
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static string CleanNameForLine(string name)
        {
            if (string.IsNullOrEmpty(name)) return "Player";
            string clean = name.Replace("|", " ").Replace("\r", "").Replace("\n", "");
            clean = Regex.Replace(clean, @"<[^>]*>", string.Empty);
            return string.IsNullOrWhiteSpace(clean) ? "Player" : clean.Trim();
        }

        public static void ReportScoreToWebAsync(ulong steamId, string playerName, float currentElo, int wins, int totalMatches, bool isWin)
        {
            if (steamId <= 1 || !Configuration.EnableWebLeaderboard) return;

            ulong hostId = Utility.Utility.GetMyID();
            if (!IsAuthorizedHost(hostId)) return;

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, sslPolicyErrors) => true;

                    long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                    string safeName = CleanNameForLine(playerName);
                    string rawLine = $"{steamId}|Username:{safeName}|CurrentElo:{(int)currentElo}|Wins:{wins}|TotalMatches:{totalMatches}";
                    string jsonBody = $"{{\"steamId\":\"{steamId}\",\"name\":\"{EscapeJson(safeName)}\",\"rawLine\":\"{EscapeJson(rawLine)}\",\"isWin\":{(isWin ? "true" : "false")}}}";

                    string signature = GenerateSignature(jsonBody, timestamp, hostId);
                    byte[] postData = Encoding.UTF8.GetBytes(jsonBody);

                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Configuration.WebBaseApiUrl);
                    request.Method = "POST";
                    request.ContentType = "application/json; charset=utf-8";

                    request.Headers.Add("x-api-key", Configuration.WebApiSecretKey);
                    request.Headers.Add("x-host-steamid", hostId.ToString());
                    request.Headers.Add("x-timestamp", timestamp.ToString());
                    request.Headers.Add("x-signature", signature);

                    request.ContentLength = postData.Length;
                    request.Timeout = 8000;
                    request.KeepAlive = false;

                    using (Stream stream = request.GetRequestStream())
                    {
                        stream.Write(postData, 0, postData.Length);
                    }

                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { }
                }
                catch { }
            });
        }

        public static void ReportBindToWebAsync(ulong steamId, string playerName, string customRegion)
        {
            if (!Configuration.EnableWebLeaderboard || steamId <= 1) return;

            ulong hostId = Utility.Utility.GetMyID();
            if (!IsAuthorizedHost(hostId)) return;

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, sslPolicyErrors) => true;

                    string safeName = CleanNameForLine(playerName);
                    string json = $"{{\"steamId\":\"{steamId}\",\"name\":\"{EscapeJson(safeName)}\",\"region\":\"{customRegion}\"}}";
                    byte[] data = Encoding.UTF8.GetBytes(json);

                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Configuration.WebBindApiUrl);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Headers.Add("x-api-key", Configuration.WebApiSecretKey);
                    req.Headers.Add("x-host-steamid", hostId.ToString());
                    req.ContentLength = data.Length;
                    req.Timeout = 5000;

                    using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
                }
                catch { }
            });
        }

        // 🚫【核心强化】：扫描 banlogs 文件夹所有 txt 原始文本，一键全量推送到网站
        public static void SyncAllBanLogsToWeb()
        {
            if (!Configuration.EnableWebLeaderboard) return;

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string banLogsDir = Path.Combine(Paths.BepInExRootPath, "Crab1v1Server", "banlogs");
                    if (!Directory.Exists(banLogsDir)) return;

                    string[] files = Directory.GetFiles(banLogsDir, "ban_*.txt");
                    if (files.Length == 0) return;

                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, sslPolicyErrors) => true;

                    string baseRoot = Configuration.WebBaseApiUrl.TrimEnd('/');
                    if (baseRoot.EndsWith("/score")) baseRoot = baseRoot.Substring(0, baseRoot.Length - 6);

                    StringBuilder sb = new StringBuilder();
                    foreach (var file in files)
                    {
                        try
                        {
                            string content = File.ReadAllText(file);
                            if (!string.IsNullOrWhiteSpace(content))
                            {
                                sb.AppendLine(content);
                                sb.AppendLine("===BAN_LOG_SPLIT===");
                            }
                        }
                        catch { }
                    }

                    if (sb.Length > 0)
                    {
                        byte[] data = Encoding.UTF8.GetBytes(sb.ToString());

                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create($"{baseRoot}/mod/ban-batch");
                        req.Method = "POST";
                        req.ContentType = "text/plain; charset=utf-8";
                        req.Headers.Add("x-api-key", Configuration.WebApiSecretKey);
                        req.ContentLength = data.Length;
                        req.Timeout = 10000;

                        using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
                    }
                }
                catch { }
            });
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
        }

        public static void FetchPlayerFromCloudAsync(ulong steamId, Action<int, int, int, string> onLoaded)
        {
            if (steamId <= 1 || !Configuration.EnableWebLeaderboard) return;

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, sslPolicyErrors) => true;

                    string baseRoot = Configuration.WebBaseApiUrl.TrimEnd('/');
                    if (baseRoot.EndsWith("/score")) baseRoot = baseRoot.Substring(0, baseRoot.Length - 6);

                    string url = $"{baseRoot}/player/{steamId}";
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "GET";
                    request.Timeout = 4000;

                    using var response = (HttpWebResponse)request.GetResponse();
                    using var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8);
                    string json = reader.ReadToEnd();

                    if (json.Contains("\"status\":\"success\""))
                    {
                        int score = ExtractIntFromJson(json, "score", 1000);
                        int wins = ExtractIntFromJson(json, "wins", 0);
                        int matches = ExtractIntFromJson(json, "matches", 0);
                        int losses = Math.Max(0, matches - wins);
                        string region = ExtractStringFromJson(json, "region", "GLOBAL");

                        onLoaded?.Invoke(score, wins, losses, region);
                    }
                }
                catch { }
            });
        }

        public static void FetchPlayerRankFromCloudAsync(ulong steamId, Action<int, int, int, int, int, int> onResult)
        {
            if (steamId <= 1 || !Configuration.EnableWebLeaderboard)
            {
                onResult?.Invoke(-1, 0, 0, 0, 0, 0);
                return;
            }

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, sslPolicyErrors) => true;

                    string baseRoot = Configuration.WebBaseApiUrl.TrimEnd('/');
                    if (baseRoot.EndsWith("/score")) baseRoot = baseRoot.Substring(0, baseRoot.Length - 6);

                    string url = $"{baseRoot}/player/{steamId}/rank";
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "GET";
                    request.Timeout = 4000;

                    using var response = (HttpWebResponse)request.GetResponse();
                    using var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8);
                    string json = reader.ReadToEnd();

                    if (json.Contains("\"status\":\"success\""))
                    {
                        int rank = ExtractIntFromJson(json, "rank", -1);
                        int score = ExtractIntFromJson(json, "score", 1000);
                        int peak = ExtractIntFromJson(json, "peakScore", score);
                        int wins = ExtractIntFromJson(json, "wins", 0);
                        int matches = ExtractIntFromJson(json, "matches", 0);
                        int bestStreak = ExtractIntFromJson(json, "bestStreak", 0);

                        onResult?.Invoke(rank, score, peak, wins, matches, bestStreak);
                        return;
                    }
                }
                catch { }

                onResult?.Invoke(-1, 0, 0, 0, 0, 0);
            });
        }

        private static int ExtractIntFromJson(string json, string key, int defaultVal)
        {
            var match = Regex.Match(json, $"\"{key}\"\\s*:\\s*(\\d+)");
            if (match.Success && int.TryParse(match.Groups[1].Value, out int v)) return v;
            return defaultVal;
        }

        private static string ExtractStringFromJson(string json, string key, string defaultVal)
        {
            var match = Regex.Match(json, $"\"{key}\"\\s*:\\s*\"([^\"]+)\"");
            if (match.Success) return match.Groups[1].Value;
            return defaultVal;
        }
    }
}
