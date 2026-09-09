# Deployment Alternatives — Oracle / Scaleway / OVHcloud

The OTel demo stack needs ~8 GB RAM minimum (7.5 GB containers + OS overhead), ideally 16 GB for the full stack including OpenSearch and the load generator. ARM64 is preferred where available — the demo publishes `linux/arm64` images natively.

Once you have a server on any of these providers, the actual deployment steps are identical — see `supa-otel-deployed.md`.

---

## Option A — Oracle Cloud Free Tier (try first)

**Why:** Genuinely always-free ARM instance. 4 OCPU + up to 24 GB RAM at zero cost forever.

**The catch:** High demand → "Out of capacity" errors on first try. Needs retrying or a script.

### Steps

1. Sign in at [cloud.oracle.com](https://cloud.oracle.com) with the account you created
2. Go to **Compute → Instances → Create Instance**
3. Click **Edit** next to "Image and shape"
   - Image: **Ubuntu 22.04** (Canonical)
   - Shape: click **Change shape** → **Ampere** → `VM.Standard.A1.Flex`
   - Set **OCPUs: 4** and **Memory: 24 GB** (maximum free allocation)
4. Under **Networking**: make sure a VCN is selected (create one if prompted — defaults are fine)
5. Under **Add SSH keys**: paste your public key (`cat ~/.ssh/id_ed25519.pub`)
6. Click **Create**

**If you get "Out of capacity":** This is common. Options:
   - Try a different **region** — check your account's home region and try another (e.g. if you signed up in US East, try US West or Frankfurt)
   - Retry every few hours — capacity opens up unpredictably
   - Use this script from your Mac to retry automatically:
     ```bash
     # Requires OCI CLI: brew install oci-cli, then oci setup config
     while true; do
       echo "Trying at $(date)..."
       oci compute instance launch \
         --availability-domain "<your-AD>" \
         --compartment-id "<your-compartment-ocid>" \
         --shape VM.Standard.A1.Flex \
         --shape-config '{"ocpus": 4, "memoryInGBs": 24}' \
         --image-id "<ubuntu-arm-image-ocid>" \
         --subnet-id "<your-subnet-ocid>" \
         --ssh-authorized-keys-file ~/.ssh/id_ed25519.pub && break
       sleep 60
     done
     ```

### Open the firewall (Security List)

Oracle's default firewall blocks everything except SSH. After the instance is created:

1. Go to **Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List**
2. Add Ingress rules:
   - Source: `0.0.0.0/0`, Protocol: TCP, Port: **80**
   - Source: `0.0.0.0/0`, Protocol: TCP, Port: **443**
3. Also open ports in the **OS firewall** after SSH-ing in:
   ```bash
   iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   iptables-save > /etc/iptables/rules.v4
   ```
   (Oracle Ubuntu images have iptables rules that override ufw — both need updating)

### Cost

Free — always. Included in Oracle's Always Free tier. Confirm on their [always-free page](https://www.oracle.com/cloud/free/#always-free) before relying on it.

---

## Option B — Scaleway

**Why:** European cloud (Paris/Amsterdam), competitive ARM pricing, straightforward UI.

**Instance to look for:** In their console, look under **Instances** for the **COPARM** series (Ampere ARM) or **GP1** series (x86). You need at least 16 GB RAM.

### Steps

1. Create account at [scaleway.com](https://console.scaleway.com)
2. Go to **Compute → Instances → Create Instance**
3. Choose a region (Paris or Amsterdam)
4. Select image: **Ubuntu 24.04**
5. Select instance type:
   - Look for an ARM instance with ≥16 GB (check their current COPARM or AMP2 line)
   - Or x86: look for anything with 16 GB RAM in the GP1 or PRO2 line
   - **Verify current pricing on their site** — prices change and vary by region
6. Add your SSH key
7. Create

### Firewall

Scaleway has a Security Groups feature (under **Network → Security Groups**). By default port 22 is open. Add rules for 80 and 443, then attach the group to your instance.

### Cost

Check [scaleway.com/en/pricing](https://www.scaleway.com/en/pricing/) under "Instances" — filter by RAM. Do not rely on any number I give you here; their pricing changes.

---

## Option C — OVHcloud

**Why:** French cloud, often very cheap for EU-based hosting, VAT-inclusive pricing is what you pay.

**Product line to look at:** Their **VPS** range (simple, single-server) rather than their Bare Metal or Public Cloud — VPS is the most straightforward for this use case.

### Steps

1. Create account at [ovhcloud.com](https://www.ovhcloud.com)
2. Go to **Bare Metal Cloud → VPS**
3. Browse the VPS tiers — you need **≥16 GB RAM**. Look at:
   - **VPS Elite** or **VPS Comfort** depending on their current lineup
   - Check the "Extra" line if the standard doesn't go high enough
4. Select **Ubuntu 24.04**
5. Complete order — OVHcloud uses a traditional order flow (not instant provisioning)
6. SSH key can be added during order or after via their control panel

### Firewall

OVHcloud VPS has no firewall by default — everything is open. Add ufw rules immediately after first login:

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

### Cost

Check [ovhcloud.com/en/vps](https://www.ovhcloud.com/en/vps/) for current pricing. Note: prices shown may be ex-VAT — the checkout total will be higher if VAT applies to your location.

---

## Comparison summary

| Provider | RAM needed | Free tier | Availability | Notes |
|---|---|---|---|---|
| Oracle Cloud | 24 GB ARM | Yes (always free) | Often "out of capacity" | Best if you can get it |
| Scaleway | 16 GB | No | Generally reliable | Verify current pricing |
| OVHcloud | 16 GB | No | Generally reliable | Order flow, not instant |
| Hetzner CAX31 | 16 GB ARM | No | Currently unavailable | Check back — usually cheapest paid option |

---

## After provisioning (all providers)

Once you have SSH access, the bootstrap and deployment steps are identical regardless of provider. Follow `supa-otel-deployed.md` from "Server setup" onward.

The one variable is the firewall — each provider handles it slightly differently, as noted above. Get ports 80 and 443 open before running Caddy.
