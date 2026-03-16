// =============================================
//   HMI FASHION STORE — PRODUCTS DATA FILE
//   Naya product add karne ke liye yahan edit karo
// =============================================

const products = [

  // ========== SAREES ==========
  {
    id: 1,
    name: "Banarasi Silk Saree",
    cat: "Saree",
    emoji: "🥻",
    bg: "#fce7f3",
    price: 2499,
    old: 3999,
    badge: "Bestseller",
    desc: "Pure Banarasi silk with golden zari work"
  },
  {
    id: 2,
    name: "Chiffon Printed Saree",
    cat: "Saree",
    emoji: "🌸",
    bg: "#fef9c3",
    price: 1199,
    old: 1999,
    badge: "New 2026",
    desc: "Light & breezy chiffon with floral prints"
  },
  {
    id: 3,
    name: "Cotton Handloom Saree",
    cat: "Saree",
    emoji: "🪡",
    bg: "#dcfce7",
    price: 899,
    old: 1499,
    badge: "Sale",
    desc: "Comfortable daily wear cotton saree"
  },

  // ========== SUITS / SALWAR ==========
  {
    id: 4,
    name: "Designer Anarkali Suit",
    cat: "Suit",
    emoji: "👗",
    bg: "#ede9fe",
    price: 1899,
    old: 2999,
    badge: "Popular",
    desc: "Elegant Anarkali with embroidery work"
  },
  {
    id: 5,
    name: "Cotton Salwar Set",
    cat: "Suit",
    emoji: "🌿",
    bg: "#dcfce7",
    price: 999,
    old: 1499,
    badge: "Sale",
    desc: "Comfortable daily wear salwar set"
  },
  {
    id: 6,
    name: "Punjabi Patiala Suit",
    cat: "Suit",
    emoji: "💐",
    bg: "#fce7f3",
    price: 1299,
    old: 1999,
    badge: "New 2026",
    desc: "Vibrant Punjabi style Patiala with dupatta"
  },

  // ========== KURTIS ==========
  {
    id: 7,
    name: "Embroidered Kurti",
    cat: "Kurti",
    emoji: "👘",
    bg: "#fff0f8",
    price: 699,
    old: 1099,
    badge: "New 2026",
    desc: "Beautiful hand embroidered kurti"
  },
  {
    id: 8,
    name: "Printed Rayon Kurti",
    cat: "Kurti",
    emoji: "🌺",
    bg: "#fef3c7",
    price: 499,
    old: 799,
    badge: "Sale",
    desc: "Trendy rayon kurti with digital print"
  },
  {
    id: 9,
    name: "Long Flared Kurti",
    cat: "Kurti",
    emoji: "🌼",
    bg: "#ede9fe",
    price: 849,
    old: 1299,
    badge: "Popular",
    desc: "Stylish long flared kurti for all occasions"
  },

  // ========== LEHENGAS ==========
  {
    id: 10,
    name: "Bridal Lehenga",
    cat: "Lehenga",
    emoji: "💃",
    bg: "#fce7f3",
    price: 7999,
    old: 12999,
    badge: "Premium",
    desc: "Stunning bridal lehenga with heavy zari work"
  },
  {
    id: 11,
    name: "Party Wear Lehenga",
    cat: "Lehenga",
    emoji: "✨",
    bg: "#ede9fe",
    price: 3499,
    old: 5999,
    badge: "Popular",
    desc: "Gorgeous party wear lehenga with sequence"
  },
  {
    id: 12,
    name: "Casual Lehenga Skirt",
    cat: "Lehenga",
    emoji: "🎀",
    bg: "#fef9c3",
    price: 1599,
    old: 2499,
    badge: "New 2026",
    desc: "Lightweight casual lehenga skirt with kurti"
  },

  // ========== MEN'S WEAR ==========
  {
    id: 13,
    name: "Ethnic Kurta Pajama",
    cat: "Men",
    emoji: "👔",
    bg: "#dbeafe",
    price: 1299,
    old: 1999,
    badge: "New 2026",
    desc: "Classic ethnic kurta pajama set"
  },
  {
    id: 14,
    name: "Sherwani Set",
    cat: "Men",
    emoji: "🤵",
    bg: "#fef9c3",
    price: 5999,
    old: 8999,
    badge: "Premium",
    desc: "Royal sherwani set for weddings & parties"
  },
  {
    id: 15,
    name: "Nehru Jacket Set",
    cat: "Men",
    emoji: "🎩",
    bg: "#dcfce7",
    price: 1899,
    old: 2999,
    badge: "Popular",
    desc: "Stylish Nehru jacket with kurta"
  },

  // ========== KIDS WEAR ==========
  {
    id: 16,
    name: "Girls Lehenga Choli",
    cat: "Kids",
    emoji: "🎀",
    bg: "#fce7f3",
    price: 899,
    old: 1499,
    badge: "Cute",
    desc: "Adorable lehenga choli for little girls"
  },
  {
    id: 17,
    name: "Boys Kurta Set",
    cat: "Kids",
    emoji: "🧒",
    bg: "#dbeafe",
    price: 699,
    old: 999,
    badge: "New 2026",
    desc: "Cute ethnic kurta set for boys"
  },
  {
    id: 18,
    name: "Kids Party Frock",
    cat: "Kids",
    emoji: "👸",
    bg: "#ede9fe",
    price: 799,
    old: 1299,
    badge: "Popular",
    desc: "Beautiful party frock for girls"
  },
  {
    id: 19,
    name: "Kids Casual Set",
    cat: "Kids",
    emoji: "🌈",
    bg: "#dcfce7",
    price: 549,
    old: 899,
    badge: "Sale",
    desc: "Comfortable everyday casual set for kids"
  },

];

// =============================================
//  NAYA PRODUCT ADD KARNE KA TARIKA:
//
//  Upar list mein neeche wali entry copy karo
//  aur apna product ka data bharo:
//
//  {
//    id: 20,               ← agle number se shuru karo
//    name: "Product Name", ← product ka naam
//    cat: "Saree",         ← category: Saree/Suit/Kurti/Lehenga/Men/Kids
//    emoji: "🥻",          ← koi bhi emoji
//    bg: "#fce7f3",        ← background color
//    price: 999,           ← selling price
//    old: 1499,            ← original price
//    badge: "New",         ← badge text
//    desc: "Description"   ← product description
//  },
// =============================================
