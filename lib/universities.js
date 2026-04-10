/**
 * University registry for multi-campus dating platform.
 * Each entry defines: id, name, short name, student email domains, campuses.
 */

const UNIVERSITIES = [
  {
    id: "scu",
    name: "四川大学",
    short: "SCU",
    domains: ["stu.scu.edu.cn", "scu.edu.cn", "mails.scu.edu.cn", "email.scu.edu.cn", "alu.scu.edu.cn"],
    defaultDomain: "stu.scu.edu.cn",
    campuses: ["望江", "江安", "华西"]
  },
  {
    id: "uestc",
    name: "电子科技大学",
    short: "UESTC",
    domains: ["std.uestc.edu.cn", "uestc.edu.cn"],
    defaultDomain: "std.uestc.edu.cn",
    campuses: ["清水河", "沙河"]
  },
  {
    id: "swjtu",
    name: "西南交通大学",
    short: "SWJTU",
    domains: ["my.swjtu.edu.cn", "swjtu.edu.cn"],
    defaultDomain: "my.swjtu.edu.cn",
    campuses: ["犀浦", "九里", "峨眉"]
  },
  {
    id: "swufe",
    name: "西南财经大学",
    short: "SWUFE",
    domains: ["stu.swufe.edu.cn", "swufe.edu.cn"],
    defaultDomain: "stu.swufe.edu.cn",
    campuses: ["柳林", "光华"]
  },
  {
    id: "sicau",
    name: "四川农业大学",
    short: "SICAU",
    domains: ["stu.sicau.edu.cn", "sicau.edu.cn"],
    defaultDomain: "stu.sicau.edu.cn",
    campuses: ["成都", "雅安", "都江堰"]
  },
  {
    id: "swun",
    name: "西南民族大学",
    short: "SWUN",
    domains: ["stu.swun.edu.cn", "swun.edu.cn"],
    defaultDomain: "stu.swun.edu.cn",
    campuses: ["航空港", "太平园"]
  },
  {
    id: "cdut",
    name: "成都理工大学",
    short: "CDUT",
    domains: ["stu.cdut.edu.cn", "cdut.edu.cn"],
    defaultDomain: "stu.cdut.edu.cn",
    campuses: ["成都", "宜宾"]
  },
  {
    id: "swpu",
    name: "西南石油大学",
    short: "SWPU",
    domains: ["stu.swpu.edu.cn", "swpu.edu.cn"],
    defaultDomain: "stu.swpu.edu.cn",
    campuses: ["成都", "南充"]
  },
  {
    id: "cdu",
    name: "成都大学",
    short: "CDU",
    domains: ["stu.cdu.edu.cn", "cdu.edu.cn"],
    defaultDomain: "stu.cdu.edu.cn",
    campuses: ["十陵"]
  },
  {
    id: "sicnu",
    name: "四川师范大学",
    short: "SICNU",
    domains: ["stu.sicnu.edu.cn", "sicnu.edu.cn"],
    defaultDomain: "stu.sicnu.edu.cn",
    campuses: ["狮子山", "成龙"]
  },
  {
    id: "xhu",
    name: "西华大学",
    short: "XHU",
    domains: ["stu.xhu.edu.cn", "xhu.edu.cn"],
    defaultDomain: "stu.xhu.edu.cn",
    campuses: ["郫都", "彭州"]
  }
];

/** All allowed email domains across all universities */
function getAllDomains() {
  return UNIVERSITIES.flatMap((u) => u.domains);
}

/** Find university by email domain */
function findByDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return UNIVERSITIES.find((u) => u.domains.includes(d)) || null;
}

/** Find university by id */
function findById(id) {
  return UNIVERSITIES.find((u) => u.id === id) || null;
}

/** Get client-safe university list (for API response) */
function getClientList() {
  return UNIVERSITIES.map((u) => ({
    id: u.id,
    name: u.name,
    short: u.short,
    defaultDomain: u.defaultDomain,
    campuses: u.campuses
  }));
}

module.exports = { UNIVERSITIES, getAllDomains, findByDomain, findById, getClientList };
